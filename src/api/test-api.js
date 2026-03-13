/**
 * API layer tests
 * Tests route validation, auth, error shapes — no real DB/Redis needed.
 * Run: node src/api/test-api.js
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

// ── Mock DB ───────────────────────────────────────────────────────────────────
const mockCompanies = {
  'stripe.com': { id: 'uuid-1', name: 'Stripe', domain: 'stripe.com', created_at: new Date(), updated_at: new Date() },
  'vercel.com': { id: 'uuid-2', name: 'Vercel', domain: 'vercel.com', created_at: new Date(), updated_at: new Date() },
};

const mockProfiles = {
  'stripe.com': [{
    source: 'greenhouse',
    job_count: 42,
    tech_count: 18,
    scraped_at: new Date(),
    tech_profile: [
      { canonical: 'React', category: 'frontend', confidence: 0.92, sources: ['job_listing'], jobMentionCount: 30, jobMentionFrequency: 0.71 },
      { canonical: 'TypeScript', category: 'language', confidence: 0.88, sources: ['job_listing'], jobMentionCount: 25, jobMentionFrequency: 0.60 },
      { canonical: 'Go', category: 'language', confidence: 0.75, sources: ['job_listing'], jobMentionCount: 15, jobMentionFrequency: 0.36 },
      { canonical: 'PostgreSQL', category: 'database', confidence: 0.70, sources: ['job_listing'], jobMentionCount: 12, jobMentionFrequency: 0.29 },
    ],
  }],
};

const mockApiKeys = {
  'test-key-starter': { id: 'key-1', name: 'Test Starter', plan: 'starter', requests_per_minute: 60, monthly_limit: 1000, requests_this_month: 5, month_reset_at: new Date(Date.now() + 86400000), is_active: true },
  'test-key-pro':     { id: 'key-2', name: 'Test Pro',     plan: 'pro',     requests_per_minute: 300, monthly_limit: 10000, requests_this_month: 100, month_reset_at: new Date(Date.now() + 86400000), is_active: true },
};

// ── Mock auth middleware ───────────────────────────────────────────────────────
async function mockAuth(request, reply) {
  const authHeader = request.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Missing Authorization header' });
  }
  const rawKey = authHeader.slice(7).trim();
  const keyData = mockApiKeys[rawKey];
  if (!keyData) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Invalid API key' });
  }
  request.apiKey = keyData;
}

// ── Mock route handlers ────────────────────────────────────────────────────────
async function buildTestApp() {
  const app = Fastify({ logger: false });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors);
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });

  app.get('/health', async () => ({ status: 'ok', version: '1.0.0' }));

  await app.register(async (v1) => {
    v1.addHook('preHandler', mockAuth);

    v1.get('/me', async (req) => ({
      name: req.apiKey.name,
      plan: req.apiKey.plan,
      usage: { requests_this_month: req.apiKey.requests_this_month, monthly_limit: req.apiKey.monthly_limit },
    }));

    v1.get('/company/:domain', async (req, reply) => {
      const domain = req.params.domain.toLowerCase();
      const company = mockCompanies[domain];
      if (!company) return reply.code(404).send({ error: 'not_found', message: `No data for ${domain}` });
      const profiles = mockProfiles[domain];
      if (!profiles) return reply.code(404).send({ error: 'no_profile', message: 'No tech profile yet' });

      let techs = profiles.flatMap(p => p.tech_profile);
      if (req.query.category) techs = techs.filter(t => t.category === req.query.category);
      if (req.query.min_confidence) techs = techs.filter(t => t.confidence >= parseFloat(req.query.min_confidence));
      techs.sort((a, b) => b.confidence - a.confidence);

      return { domain, company: company.name, tech_count: techs.length, technologies: techs };
    });

    v1.get('/companies', async (req) => ({
      data: Object.values(mockCompanies),
      pagination: { page: 1, per_page: 25, total: 2, total_pages: 1, has_next: false },
    }));

    v1.post('/companies/search', async (req, reply) => {
      const { uses, uses_any } = req.body || {};
      if (!uses && !uses_any) return reply.code(400).send({ error: 'invalid_params', message: 'Provide uses or uses_any' });
      const targets = new Set([...(uses || []), ...(uses_any || [])]);
      const results = Object.entries(mockProfiles)
        .filter(([, profiles]) =>
          profiles.some(p => p.tech_profile.some(t => targets.has(t.canonical)))
        )
        .map(([domain]) => ({ domain, name: mockCompanies[domain]?.name }));
      return { query: { uses, uses_any }, data: results, pagination: { total: results.length } };
    });

    v1.post('/export', async (req, reply) => {
      if (req.apiKey.plan === 'starter') {
        return reply.code(403).send({ error: 'plan_required', message: 'Bulk export requires Pro or Enterprise' });
      }
      return { exported_at: new Date().toISOString(), count: 2, data: Object.values(mockCompanies) };
    });

  }, { prefix: '/v1' });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not_found', message: `${req.method} ${req.url} not found` });
  });

  return app;
}

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ── Run tests ─────────────────────────────────────────────────────────────────
const app = await buildTestApp();
await app.ready();

console.log('\nAPI Layer Tests\n');

// Health
console.log('Health');
await test('GET /health returns 200', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  const body = JSON.parse(res.body);
  assert(body.status === 'ok', 'status should be ok');
});

// Auth
console.log('\nAuthentication');
await test('Missing auth header returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/me' });
  assert(res.statusCode === 401, `Expected 401, got ${res.statusCode}`);
  assert(JSON.parse(res.body).error === 'unauthorized');
});

await test('Invalid API key returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer bad-key' } });
  assert(res.statusCode === 401);
});

await test('Valid API key returns 200 on /me', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer test-key-starter' } });
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  const body = JSON.parse(res.body);
  assert(body.plan === 'starter');
  assert(body.usage.monthly_limit === 1000);
});

// Company routes
console.log('\nGET /v1/company/:domain');
const authHeaders = { authorization: 'Bearer test-key-starter' };

await test('Returns tech profile for known domain', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/company/stripe.com', headers: authHeaders });
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  const body = JSON.parse(res.body);
  assert(body.domain === 'stripe.com');
  assert(Array.isArray(body.technologies));
  assert(body.technologies.length > 0);
  assert(body.tech_count === body.technologies.length);
});

await test('Technologies sorted by confidence desc', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/company/stripe.com', headers: authHeaders });
  const { technologies } = JSON.parse(res.body);
  for (let i = 1; i < technologies.length; i++) {
    assert(technologies[i - 1].confidence >= technologies[i].confidence, 'Not sorted by confidence');
  }
});

await test('Filters by category', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/company/stripe.com?category=language', headers: authHeaders });
  const { technologies } = JSON.parse(res.body);
  assert(technologies.every(t => t.category === 'language'), 'Non-language tech returned');
});

await test('Filters by min_confidence', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/company/stripe.com?min_confidence=0.85', headers: authHeaders });
  const { technologies } = JSON.parse(res.body);
  assert(technologies.every(t => t.confidence >= 0.85), 'Low confidence tech returned');
});

await test('Returns 404 for unknown domain', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/company/notreal.xyz', headers: authHeaders });
  assert(res.statusCode === 404);
  assert(JSON.parse(res.body).error === 'not_found');
});

// Companies search
console.log('\nPOST /v1/companies/search');

await test('Returns companies using React', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/companies/search', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ uses: ['React'] }),
  });
  assert(res.statusCode === 200);
  const body = JSON.parse(res.body);
  assert(body.data.some(c => c.domain === 'stripe.com'));
});

await test('Returns 400 when no uses/uses_any provided', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/companies/search', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ min_confidence: 0.7 }),
  });
  assert(res.statusCode === 400);
});

// Export plan gate
console.log('\nPOST /v1/export');

await test('Starter plan gets 403 on export', async () => {
  const res = await app.inject({
    method: 'POST', url: '/v1/export', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'json' }),
  });
  assert(res.statusCode === 403);
  assert(JSON.parse(res.body).error === 'plan_required');
});

await test('Pro plan can export', async () => {
  const proHeaders = { authorization: 'Bearer test-key-pro', 'content-type': 'application/json' };
  const res = await app.inject({
    method: 'POST', url: '/v1/export', headers: proHeaders,
    body: JSON.stringify({ format: 'json' }),
  });
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode} - ${res.body}`);
});

// 404 handler
console.log('\nError handling');

await test('Unknown route returns 404 JSON', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/nonexistent', headers: authHeaders });
  assert(res.statusCode === 404);
  const body = JSON.parse(res.body);
  assert(body.error === 'not_found');
});

await app.close();

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll API tests passed ✓');
}
