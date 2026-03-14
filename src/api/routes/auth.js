import crypto from 'crypto';
import { query } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

export async function authRoutes(fastify) {
  // POST /v1/auth/signup — create a free starter API key
  fastify.post('/signup', async (request, reply) => {
    const { name, email } = request.body || {};

    if (!email || !email.includes('@')) {
      return reply.code(400).send({ error: 'invalid_email', message: 'A valid email is required' });
    }

    // Prevent duplicate keys for same email
    const existing = await query(
      'SELECT id FROM api_keys WHERE email = $1 AND is_active = true LIMIT 1',
      [email.toLowerCase().trim()]
    );
    if (existing.rows.length > 0) {
      return reply.code(409).send({
        error: 'email_exists',
        message: 'An API key already exists for this email. Contact support@techstackdata.io to retrieve it.',
      });
    }

    const rawKey = 'tsd_' + crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const displayName = name?.trim() || email.split('@')[0];

    await query(
      `INSERT INTO api_keys (key_hash, name, email, plan, requests_per_minute, monthly_limit)
       VALUES ($1, $2, $3, 'starter', 60, 1000)`,
      [keyHash, displayName, email.toLowerCase().trim()]
    );

    logger.info('New starter key created', { email, name: displayName });

    return reply.code(201).send({
      api_key: rawKey,
      plan: 'starter',
      monthly_limit: 1000,
      requests_per_minute: 60,
      message: 'Save this key — it cannot be shown again.',
    });
  });
}
