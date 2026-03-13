import { query } from '../../db/client.js';
import { logger } from '../../utils/logger.js';

// Schema for api_keys table (add to schema.sql):
//
// CREATE TABLE IF NOT EXISTS api_keys (
//   id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
//   key_hash    TEXT UNIQUE NOT NULL,   -- SHA-256 of the raw key
//   name        TEXT NOT NULL,          -- owner label e.g. "Acme Corp"
//   plan        TEXT NOT NULL DEFAULT 'starter',  -- starter | pro | enterprise
//   requests_per_minute INTEGER NOT NULL DEFAULT 60,
//   monthly_limit       INTEGER NOT NULL DEFAULT 1000,
//   requests_this_month INTEGER NOT NULL DEFAULT 0,
//   month_reset_at      TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', NOW()) + interval '1 month',
//   is_active   BOOLEAN NOT NULL DEFAULT true,
//   created_at  TIMESTAMPTZ DEFAULT NOW(),
//   last_used_at TIMESTAMPTZ
// );

import crypto from 'crypto';

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// In-memory cache: hash -> { plan, requests_per_minute, monthly_limit, ... }
// TTL: 60 seconds so revokes propagate quickly
const keyCache = new Map(); // hash -> { data, expiresAt }
const CACHE_TTL_MS = 60_000;

async function lookupKey(rawKey) {
  const hash = hashKey(rawKey);

  const cached = keyCache.get(hash);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  let keyRow;
  try {
    const result = await query(
      `SELECT id, name, plan, requests_per_minute, monthly_limit,
              requests_this_month, month_reset_at, is_active
       FROM api_keys WHERE key_hash = $1`,
      [hash]
    );
    keyRow = result.rows[0] || null;
  } catch {
    // DB unavailable — return null; caller handles 503
    return null;
  }

  keyCache.set(hash, { data: keyRow, expiresAt: Date.now() + CACHE_TTL_MS });
  return keyRow;
}

export function invalidateKeyCache(rawKey) {
  keyCache.delete(hashKey(rawKey));
}

export async function authMiddleware(request, reply) {
  const authHeader = request.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({
      error: 'unauthorized',
      message: 'Missing or malformed Authorization header. Use: Authorization: Bearer <api_key>',
    });
  }

  const rawKey = authHeader.slice(7).trim();
  if (!rawKey) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Empty API key' });
  }

  const keyData = await lookupKey(rawKey);

  if (!keyData) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Invalid API key' });
  }

  if (!keyData.is_active) {
    return reply.code(403).send({ error: 'forbidden', message: 'API key has been deactivated' });
  }

  // Reset monthly counter if past reset date
  if (new Date(keyData.month_reset_at) <= new Date()) {
    try {
      await query(
        `UPDATE api_keys
         SET requests_this_month = 0,
             month_reset_at = date_trunc('month', NOW()) + interval '1 month'
         WHERE id = $1`,
        [keyData.id]
      );
      keyData.requests_this_month = 0;
    } catch { /* non-fatal */ }
  }

  // Monthly quota check
  if (keyData.requests_this_month >= keyData.monthly_limit) {
    return reply.code(429).send({
      error: 'quota_exceeded',
      message: `Monthly limit of ${keyData.monthly_limit} requests reached. Resets ${keyData.month_reset_at}.`,
      reset_at: keyData.month_reset_at,
    });
  }

  // Attach to request for downstream use
  request.apiKey = keyData;

  // Fire-and-forget: bump usage counter + last_used_at
  query(
    `UPDATE api_keys
     SET requests_this_month = requests_this_month + 1,
         last_used_at = NOW()
     WHERE id = $1`,
    [keyData.id]
  ).catch((err) => logger.warn('Failed to increment usage', { err: err.message }));
}
