/**
 * Stripe billing routes
 *
 * GET  /v1/billing/portal      — redirect to Stripe customer portal
 * POST /v1/billing/checkout    — create a checkout session for plan upgrade
 * POST /v1/billing/webhook     — Stripe webhook (no auth middleware)
 *
 * Environment variables required:
 *   STRIPE_SECRET_KEY    — sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET — whsec_...
 *   STRIPE_PRICE_PRO     — price_... for $149/mo
 *   STRIPE_PRICE_ENTERPRISE — price_... for $499/mo
 *   APP_URL              — https://techstackdata.io (used for redirect URLs)
 */

import Stripe from 'stripe';
import { query } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

const PLAN_LIMITS = {
  starter:    { requests_per_minute: 60,    monthly_limit: 1_000 },
  pro:        { requests_per_minute: 300,   monthly_limit: 10_000 },
  enterprise: { requests_per_minute: 1_000, monthly_limit: 999_999_999 },
};

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });
}

export async function billingRoutes(fastify) {
  // POST /billing/checkout — create Stripe checkout session
  fastify.post('/checkout', async (request, reply) => {
    const { plan } = request.body || {};
    if (!['pro', 'enterprise'].includes(plan)) {
      return reply.code(400).send({ error: 'invalid_plan', message: 'Plan must be pro or enterprise' });
    }

    const priceId = plan === 'pro'
      ? process.env.STRIPE_PRICE_PRO
      : process.env.STRIPE_PRICE_ENTERPRISE;

    if (!priceId) {
      return reply.code(503).send({ error: 'billing_unavailable', message: 'Billing not configured' });
    }

    let stripe;
    try { stripe = getStripe(); } catch {
      return reply.code(503).send({ error: 'billing_unavailable', message: 'Billing not configured' });
    }

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const apiKey = request.apiKey;

    // Create or retrieve Stripe customer
    let customerId = apiKey.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: apiKey.name,
        metadata: { api_key_id: apiKey.id },
      });
      customerId = customer.id;
      await query(
        'UPDATE api_keys SET stripe_customer_id = $1 WHERE id = $2',
        [customerId, apiKey.id]
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${appUrl}/billing/cancel`,
      metadata: { api_key_id: apiKey.id, plan },
      subscription_data: {
        metadata: { api_key_id: apiKey.id, plan },
      },
    });

    return reply.code(200).send({ checkout_url: session.url, session_id: session.id });
  });

  // GET /billing/portal — redirect to Stripe customer portal
  fastify.get('/portal', async (request, reply) => {
    const apiKey = request.apiKey;

    if (!apiKey.stripe_customer_id) {
      return reply.code(400).send({
        error: 'no_subscription',
        message: 'No active subscription found. Use /v1/billing/checkout to subscribe.',
      });
    }

    let stripe;
    try { stripe = getStripe(); } catch {
      return reply.code(503).send({ error: 'billing_unavailable', message: 'Billing not configured' });
    }

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const session = await stripe.billingPortal.sessions.create({
      customer: apiKey.stripe_customer_id,
      return_url: `${appUrl}/dashboard`,
    });

    return reply.code(200).send({ portal_url: session.url });
  });
}

/**
 * Stripe webhook handler — registered outside the auth middleware.
 * Handles subscription lifecycle events to sync plan in api_keys.
 */
export async function stripeWebhookRoute(fastify) {
  fastify.post('/v1/billing/webhook', {
    config: { rawBody: true },
  }, async (request, reply) => {
    const sig = request.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      logger.warn('STRIPE_WEBHOOK_SECRET not set — ignoring webhook');
      return reply.code(200).send({ received: true });
    }

    let stripe;
    try { stripe = getStripe(); } catch {
      return reply.code(503).send({ ok: false });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(request.rawBody, sig, webhookSecret);
    } catch (err) {
      logger.warn('Stripe webhook signature verification failed', { err: err.message });
      return reply.code(400).send({ error: 'invalid_signature' });
    }

    logger.info('Stripe webhook received', { type: event.type });

    try {
      await handleStripeEvent(event);
    } catch (err) {
      logger.error('Stripe webhook handler error', { type: event.type, err: err.message });
      return reply.code(500).send({ error: 'handler_error' });
    }

    return reply.code(200).send({ received: true });
  });
}

async function handleStripeEvent(event) {
  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      // Subscription created via checkout
      const apiKeyId = obj.metadata?.api_key_id;
      const plan     = obj.metadata?.plan;
      if (!apiKeyId || !plan || !PLAN_LIMITS[plan]) break;

      const limits = PLAN_LIMITS[plan];
      await query(
        `UPDATE api_keys
         SET plan = $1,
             requests_per_minute = $2,
             monthly_limit = $3,
             stripe_customer_id = $4,
             stripe_subscription_id = $5
         WHERE id = $6`,
        [plan, limits.requests_per_minute, limits.monthly_limit,
         obj.customer, obj.subscription, apiKeyId]
      );
      logger.info('Plan upgraded via checkout', { apiKeyId, plan });
      break;
    }

    case 'customer.subscription.updated': {
      const apiKeyId = obj.metadata?.api_key_id;
      const plan     = obj.metadata?.plan;
      if (!apiKeyId || !plan || !PLAN_LIMITS[plan]) break;

      if (obj.status === 'active') {
        const limits = PLAN_LIMITS[plan];
        await query(
          `UPDATE api_keys
           SET plan = $1, requests_per_minute = $2, monthly_limit = $3
           WHERE id = $4`,
          [plan, limits.requests_per_minute, limits.monthly_limit, apiKeyId]
        );
        logger.info('Subscription updated', { apiKeyId, plan });
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const apiKeyId = obj.metadata?.api_key_id;
      if (!apiKeyId) break;

      // Downgrade to starter on cancellation
      const limits = PLAN_LIMITS.starter;
      await query(
        `UPDATE api_keys
         SET plan = 'starter',
             requests_per_minute = $1,
             monthly_limit = $2,
             stripe_subscription_id = NULL
         WHERE id = $3`,
        [limits.requests_per_minute, limits.monthly_limit, apiKeyId]
      );
      logger.info('Subscription cancelled, downgraded to starter', { apiKeyId });
      break;
    }

    case 'invoice.payment_failed': {
      const customerId = obj.customer;
      logger.warn('Payment failed', { customerId, attemptCount: obj.attempt_count });
      // Could disable the key after N failures — for now just log
      break;
    }
  }
}
