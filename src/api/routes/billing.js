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

import crypto from 'crypto';
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
  // POST /billing/checkout — create Stripe checkout session (no auth required)
  // Body: { plan: 'pro' | 'enterprise', name?: string, email: string }
  fastify.post('/checkout', { preHandler: [] }, async (request, reply) => {
    const { plan, name, email } = request.body || {};

    if (!['pro', 'enterprise'].includes(plan)) {
      return reply.code(400).send({ error: 'invalid_plan', message: 'Plan must be pro or enterprise' });
    }
    if (!email || !email.includes('@')) {
      return reply.code(400).send({ error: 'email_required', message: 'A valid email is required' });
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

    // Create API key upfront with starter limits — webhook upgrades it after payment
    const rawKey = 'tsd_' + crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const displayName = name?.trim() || email.split('@')[0];

    // Reuse existing key if this email already has one
    let keyId;
    const existing = await query(
      'SELECT id FROM api_keys WHERE email = $1 AND is_active = true LIMIT 1',
      [email.toLowerCase().trim()]
    );
    if (existing.rows.length > 0) {
      keyId = existing.rows[0].id;
    } else {
      const { rows } = await query(
        `INSERT INTO api_keys (key_hash, name, email, plan, requests_per_minute, monthly_limit)
         VALUES ($1, $2, $3, 'starter', 60, 1000) RETURNING id`,
        [keyHash, displayName, email.toLowerCase().trim()]
      );
      keyId = rows[0].id;
    }

    const rawUrl = process.env.APP_URL || 'localhost:3000';
    const appUrl = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;

    const session = await stripe.checkout.sessions.create({
      customer_email: email,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/billing/success?key=${rawKey}&plan=${plan}`,
      cancel_url:  `${appUrl}/billing/cancel`,
      metadata: { api_key_id: keyId, plan },
      subscription_data: { metadata: { api_key_id: keyId, plan } },
      allow_promotion_codes: true,
    });

    // Return JSON so the front-end can redirect
    return reply.code(200).send({ checkout_url: session.url });
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
