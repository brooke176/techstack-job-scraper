import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Redis from 'ioredis';
import rawBody from 'fastify-raw-body';

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { authMiddleware } from './middleware/auth.js';
import { companyRoutes } from './routes/company.js';
import { companiesRoutes } from './routes/companies.js';
import { exportRoutes } from './routes/export.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { billingRoutes, stripeWebhookRoute } from './routes/billing.js';
import { closePool } from '../db/client.js';

export async function buildApp() {
  const app = Fastify({
    logger: false, // We use our own Winston logger
    trustProxy: true,
  });

  // ── Raw body (needed for Stripe webhook signature verification) ────────────
  await app.register(rawBody, {
    global: false, // opt-in per-route via config: { rawBody: true }
    encoding: 'utf8',
    runFirst: true,
  });

  // ── Security headers ───────────────────────────────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: false, // API, no HTML served
  });

  // ── CORS ──────────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  // ── Rate limiting (Redis-backed for distributed deployments) ───────────────
  let redisClient;
  try {
    redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    redisClient.on('error', (err) => {
      logger.warn('Redis connection error', { err: err.message });
    });
    await redisClient.connect();

    await app.register(rateLimit, {
      redis: redisClient,
      max: async (request) => {
        // Per-key rate limit from DB (set at auth time)
        return request.apiKey?.requests_per_minute ?? 60;
      },
      timeWindow: '1 minute',
      keyGenerator: (request) => {
        // Rate limit by API key ID, not IP
        return request.apiKey?.id ?? request.ip;
      },
      errorResponseBuilder: (request, context) => ({
        error: 'rate_limited',
        message: `Rate limit exceeded. Max ${context.max} requests/minute.`,
        retry_after: Math.ceil(context.ttl / 1000),
      }),
    });
  } catch (err) {
    logger.warn('Redis unavailable — falling back to in-memory rate limiting', { err: err.message });
    await app.register(rateLimit, {
      max: 60,
      timeWindow: '1 minute',
    });
  }

  // ── Request logging ────────────────────────────────────────────────────────
  app.addHook('onRequest', (request, reply, done) => {
    request.startTime = Date.now();
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    logger.info('request', {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      ms: Date.now() - (request.startTime || Date.now()),
      key: request.apiKey?.name ?? 'unauthenticated',
    });
    done();
  });

  // ── Global error handler ───────────────────────────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    logger.error('unhandled error', {
      err: error.message,
      stack: error.stack,
      url: request.url,
    });

    if (error.statusCode === 429) {
      return reply.code(429).send(error);
    }

    // Zod/validation errors bubble up as 400
    if (error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: 'client_error',
        message: error.message,
      });
    }

    return reply.code(500).send({
      error: 'internal_error',
      message: 'An unexpected error occurred. Please try again.',
    });
  });

  // ── Health check (no auth) ─────────────────────────────────────────────────
  app.get('/health', async (request, reply) => {
    return reply.code(200).send({
      status: 'ok',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    });
  });

  // ── Auth-protected routes ──────────────────────────────────────────────────
  // All routes under /v1 require a valid API key
  await app.register(async (v1) => {
    v1.addHook('preHandler', authMiddleware);

    await v1.register(companyRoutes,   { prefix: '/company' });
    await v1.register(companiesRoutes, { prefix: '/companies' });
    await v1.register(exportRoutes,    { prefix: '/export' });
    await v1.register(webhooksRoutes,  { prefix: '/webhooks' });
    await v1.register(billingRoutes,   { prefix: '/billing' });

    // GET /v1/me — returns current API key info
    v1.get('/me', async (request, reply) => {
      const key = request.apiKey;
      return reply.code(200).send({
        name: key.name,
        plan: key.plan,
        usage: {
          requests_this_month: key.requests_this_month,
          monthly_limit: key.monthly_limit,
          remaining: key.monthly_limit - key.requests_this_month,
          reset_at: key.month_reset_at,
        },
        rate_limit: {
          requests_per_minute: key.requests_per_minute,
        },
      });
    });

  }, { prefix: '/v1' });

  // ── Stripe webhook (raw body, no auth) ─────────────────────────────────────
  await app.register(async (pub) => {
    await pub.register(stripeWebhookRoute);
  });

  // ── 404 handler ────────────────────────────────────────────────────────────
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: 'not_found',
      message: `Route ${request.method} ${request.url} not found`,
      docs: 'https://docs.techstackdata.io',
    });
  });

  return { app, redisClient };
}

// ── Start server ──────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

if (process.argv[1].endsWith('server.js')) {
  const PORT = parseInt(process.env.PORT || '3000');
  const HOST = process.env.HOST || '0.0.0.0';

  const { app, redisClient } = await buildApp();

  const gracefulShutdown = async (signal) => {
    logger.info(`${signal} received — shutting down`);
    await app.close();
    await closePool();
    if (redisClient) await redisClient.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

  try {
    await app.listen({ port: PORT, host: HOST });
    logger.info(`API server listening`, { port: PORT, host: HOST });
    logger.info('Routes:', {
      endpoints: [
        'GET  /health',
        'GET  /v1/me',
        'GET  /v1/company/:domain',
        'GET  /v1/companies',
        'POST /v1/companies/search',
        'POST /v1/export',
        'GET  /v1/webhooks',
        'POST /v1/webhooks',
        'PATCH /v1/webhooks/:id',
        'DELETE /v1/webhooks/:id',
        'POST /v1/webhooks/:id/test',
      ]
    });
  } catch (err) {
    logger.error('Failed to start server', { err: err.message });
    process.exit(1);
  }
}
