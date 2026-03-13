import { query } from '../../db/client.js';
import { z } from 'zod';
import crypto from 'crypto';

// Schema (add to schema.sql):
//
// CREATE TABLE IF NOT EXISTS webhooks (
//   id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
//   api_key_id   UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
//   url          TEXT NOT NULL,
//   secret       TEXT NOT NULL,   -- HMAC secret for payload signing
//   events       TEXT[] NOT NULL DEFAULT '{tech_added,tech_removed}',
//   domains      TEXT[],          -- NULL = all domains owned by this key
//   is_active    BOOLEAN DEFAULT true,
//   created_at   TIMESTAMPTZ DEFAULT NOW(),
//   last_fired_at TIMESTAMPTZ,
//   failure_count INTEGER DEFAULT 0
// );

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(['tech_added', 'tech_removed', 'confidence_change'])).min(1).default(['tech_added', 'tech_removed']),
  domains: z.array(z.string()).max(50).optional(),  // null = all
});

const updateWebhookSchema = z.object({
  url:      z.string().url().optional(),
  events:   z.array(z.enum(['tech_added', 'tech_removed', 'confidence_change'])).min(1).optional(),
  domains:  z.array(z.string()).max(50).optional(),
  is_active: z.boolean().optional(),
});

export async function webhooksRoutes(fastify) {
  // GET /webhooks — list webhooks for this API key
  fastify.get('/', async (request, reply) => {
    const result = await query(
      `SELECT id, url, events, domains, is_active, created_at, last_fired_at, failure_count
       FROM webhooks
       WHERE api_key_id = $1
       ORDER BY created_at DESC`,
      [request.apiKey.id]
    );

    return reply.code(200).send({ data: result.rows });
  });

  // POST /webhooks — register a new webhook
  fastify.post('/', async (request, reply) => {
    const parse = createWebhookSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_params', message: parse.error.issues[0].message });
    }

    const { url, events, domains } = parse.data;

    // Limit: max 10 webhooks per key
    const countResult = await query(
      'SELECT COUNT(*) FROM webhooks WHERE api_key_id = $1',
      [request.apiKey.id]
    );
    if (parseInt(countResult.rows[0].count) >= 10) {
      return reply.code(429).send({
        error: 'limit_reached',
        message: 'Maximum of 10 webhooks per API key. Delete an existing webhook to create a new one.',
      });
    }

    const secret = crypto.randomBytes(32).toString('hex');

    const result = await query(
      `INSERT INTO webhooks (api_key_id, url, secret, events, domains)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, url, events, domains, is_active, created_at`,
      [request.apiKey.id, url, secret, events, domains || null]
    );

    const webhook = result.rows[0];

    return reply.code(201).send({
      ...webhook,
      // Return secret ONCE at creation — store it, you won't see it again
      signing_secret: secret,
      note: 'Store your signing_secret securely. It will not be shown again. Use it to verify incoming webhook payloads.',
    });
  });

  // PATCH /webhooks/:id — update a webhook
  fastify.patch('/:id', async (request, reply) => {
    const parse = updateWebhookSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_params', message: parse.error.issues[0].message });
    }

    // Ensure ownership
    const existing = await query(
      'SELECT id FROM webhooks WHERE id = $1 AND api_key_id = $2',
      [request.params.id, request.apiKey.id]
    );
    if (existing.rows.length === 0) {
      return reply.code(404).send({ error: 'not_found', message: 'Webhook not found' });
    }

    const updates = parse.data;
    const setClauses = [];
    const params = [];

    if (updates.url !== undefined)       { params.push(updates.url);      setClauses.push(`url = $${params.length}`); }
    if (updates.events !== undefined)    { params.push(updates.events);   setClauses.push(`events = $${params.length}`); }
    if (updates.domains !== undefined)   { params.push(updates.domains);  setClauses.push(`domains = $${params.length}`); }
    if (updates.is_active !== undefined) { params.push(updates.is_active);setClauses.push(`is_active = $${params.length}`); }

    if (setClauses.length === 0) {
      return reply.code(400).send({ error: 'invalid_params', message: 'No valid fields to update' });
    }

    params.push(request.params.id);
    const result = await query(
      `UPDATE webhooks SET ${setClauses.join(', ')} WHERE id = $${params.length}
       RETURNING id, url, events, domains, is_active, created_at, last_fired_at, failure_count`,
      params
    );

    return reply.code(200).send(result.rows[0]);
  });

  // DELETE /webhooks/:id
  fastify.delete('/:id', async (request, reply) => {
    const result = await query(
      'DELETE FROM webhooks WHERE id = $1 AND api_key_id = $2 RETURNING id',
      [request.params.id, request.apiKey.id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'not_found', message: 'Webhook not found' });
    }

    return reply.code(200).send({ deleted: true, id: request.params.id });
  });

  // POST /webhooks/:id/test — send a test payload to the webhook URL
  fastify.post('/:id/test', async (request, reply) => {
    const result = await query(
      'SELECT id, url, secret FROM webhooks WHERE id = $1 AND api_key_id = $2',
      [request.params.id, request.apiKey.id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'not_found', message: 'Webhook not found' });
    }

    const webhook = result.rows[0];
    const testPayload = {
      event: 'tech_added',
      domain: 'example.com',
      canonical: 'React',
      category: 'frontend',
      confidence: 0.85,
      detected_at: new Date().toISOString(),
      test: true,
    };

    const deliveryResult = await deliverWebhook(webhook, testPayload);

    return reply.code(200).send({
      delivered: deliveryResult.ok,
      status_code: deliveryResult.status,
      response_ms: deliveryResult.ms,
      error: deliveryResult.error || null,
    });
  });
}

/**
 * Deliver a webhook payload with HMAC signature.
 * Called by the change-detection job (not in API request path).
 */
export async function deliverWebhook(webhook, payload) {
  const body = JSON.stringify(payload);
  const sig = crypto
    .createHmac('sha256', webhook.secret)
    .update(body)
    .digest('hex');

  const start = Date.now();
  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TechStack-Signature': `sha256=${sig}`,
        'X-TechStack-Event': payload.event,
        'User-Agent': 'TechStackData-Webhook/1.0',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    const ms = Date.now() - start;

    if (!res.ok) {
      await query(
        'UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = $1',
        [webhook.id]
      ).catch(() => {});
    } else {
      await query(
        'UPDATE webhooks SET last_fired_at = NOW(), failure_count = 0 WHERE id = $1',
        [webhook.id]
      ).catch(() => {});
    }

    return { ok: res.ok, status: res.status, ms };
  } catch (err) {
    await query(
      'UPDATE webhooks SET failure_count = failure_count + 1 WHERE id = $1',
      [webhook.id]
    ).catch(() => {});

    return { ok: false, status: null, ms: Date.now() - start, error: err.message };
  }
}
