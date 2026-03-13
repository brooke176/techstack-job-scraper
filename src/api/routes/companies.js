import { query } from '../../db/client.js';
import { z } from 'zod';

const listQuerySchema = z.object({
  page:     z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  sort:     z.enum(['domain', 'name', 'updated_at']).default('updated_at'),
  order:    z.enum(['asc', 'desc']).default('desc'),
  q:        z.string().max(100).optional(),    // search by name/domain
});

const searchBodySchema = z.object({
  // Find companies that use ALL of these technologies
  uses:        z.array(z.string()).min(1).max(20).optional(),
  // Find companies that use ANY of these technologies
  uses_any:    z.array(z.string()).min(1).max(20).optional(),
  // Exclude companies using these
  excludes:    z.array(z.string()).max(20).optional(),
  // Filter by category
  category:    z.string().optional(),
  // Minimum confidence threshold
  min_confidence: z.number().min(0).max(1).default(0.6),
  page:        z.coerce.number().int().min(1).default(1),
  per_page:    z.coerce.number().int().min(1).max(100).default(25),
});

export async function companiesRoutes(fastify) {
  // GET /companies — paginated list with optional text search
  fastify.get('/', async (request, reply) => {
    const parse = listQuerySchema.safeParse(request.query);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_params', message: parse.error.issues[0].message });
    }

    const { page, per_page, sort, order, q } = parse.data;
    const offset = (page - 1) * per_page;

    const allowedSort = { domain: 'c.domain', name: 'c.name', updated_at: 'c.updated_at' };
    const sortCol = allowedSort[sort];

    let whereClause = '';
    const params = [];

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      whereClause = `WHERE lower(c.domain) LIKE $${params.length} OR lower(c.name) LIKE $${params.length}`;
    }

    params.push(per_page, offset);

    const [companiesResult, countResult] = await Promise.all([
      query(
        `SELECT c.domain, c.name, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM company_tech_profiles p WHERE p.domain = c.domain) AS source_count,
                (SELECT scraped_at FROM company_tech_profiles p WHERE p.domain = c.domain ORDER BY scraped_at DESC LIMIT 1) AS last_scraped
         FROM companies c
         ${whereClause}
         ORDER BY ${sortCol} ${order.toUpperCase()}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      query(
        `SELECT COUNT(*) FROM companies c ${whereClause}`,
        q ? [`%${q.toLowerCase()}%`] : []
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);

    return reply.code(200).send({
      data: companiesResult.rows,
      pagination: {
        page,
        per_page,
        total,
        total_pages: Math.ceil(total / per_page),
        has_next: page * per_page < total,
      },
    });
  });

  // POST /companies/search — filter by tech stack
  // E.g. "find all companies using React AND TypeScript but NOT Angular"
  fastify.post('/search', async (request, reply) => {
    const parse = searchBodySchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_params', message: parse.error.issues[0].message });
    }

    const { uses, uses_any, excludes, category, min_confidence, page, per_page } = parse.data;

    if (!uses && !uses_any) {
      return reply.code(400).send({
        error: 'invalid_params',
        message: 'Provide at least one of: uses, uses_any',
      });
    }

    // Build JSONB query conditions
    // tech_profile is JSONB array of { canonical, category, confidence, ... }
    const conditions = [];
    const params = [min_confidence];

    // "uses" = ALL must be present above min_confidence
    if (uses && uses.length > 0) {
      for (const tech of uses) {
        params.push(tech);
        conditions.push(
          `EXISTS (
            SELECT 1 FROM jsonb_array_elements(p.tech_profile) AS t
            WHERE t->>'canonical' = $${params.length}
            AND (t->>'confidence')::float >= $1
          )`
        );
      }
    }

    // "uses_any" = at least one must be present
    if (uses_any && uses_any.length > 0) {
      const anyConditions = [];
      for (const tech of uses_any) {
        params.push(tech);
        anyConditions.push(
          `EXISTS (
            SELECT 1 FROM jsonb_array_elements(p.tech_profile) AS t
            WHERE t->>'canonical' = $${params.length}
            AND (t->>'confidence')::float >= $1
          )`
        );
      }
      conditions.push(`(${anyConditions.join(' OR ')})`);
    }

    // "excludes" = none of these
    if (excludes && excludes.length > 0) {
      for (const tech of excludes) {
        params.push(tech);
        conditions.push(
          `NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p.tech_profile) AS t
            WHERE t->>'canonical' = $${params.length}
          )`
        );
      }
    }

    // "category" filter
    if (category) {
      params.push(category);
      conditions.push(
        `EXISTS (
          SELECT 1 FROM jsonb_array_elements(p.tech_profile) AS t
          WHERE t->>'category' = $${params.length}
          AND (t->>'confidence')::float >= $1
        )`
      );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Use latest profile per domain (subquery gets most recent scraped_at per domain)
    const offset = (page - 1) * per_page;
    params.push(per_page, offset);

    const sql = `
      WITH latest_profiles AS (
        SELECT DISTINCT ON (domain) domain, tech_profile, scraped_at, job_count
        FROM company_tech_profiles
        ORDER BY domain, scraped_at DESC
      )
      SELECT p.domain, c.name, p.scraped_at, p.job_count,
             p.tech_profile
      FROM latest_profiles p
      JOIN companies c ON c.domain = p.domain
      ${whereClause}
      ORDER BY p.scraped_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const countSql = `
      WITH latest_profiles AS (
        SELECT DISTINCT ON (domain) domain, tech_profile, scraped_at
        FROM company_tech_profiles
        ORDER BY domain, scraped_at DESC
      )
      SELECT COUNT(*) FROM latest_profiles p ${whereClause}
    `;

    const [results, countResult] = await Promise.all([
      query(sql, params),
      query(countSql, params.slice(0, params.length - 2)), // exclude LIMIT/OFFSET
    ]);

    const total = parseInt(countResult.rows[0].count);

    // Strip tech_profile from list response — caller can GET /company/:domain for full data
    const data = results.rows.map(row => ({
      domain: row.domain,
      name: row.name,
      last_scraped: row.scraped_at,
      job_count: row.job_count,
      matched_technologies: filterMatchedTechs(row.tech_profile, { uses, uses_any, min_confidence }),
    }));

    return reply.code(200).send({
      query: { uses, uses_any, excludes, category, min_confidence },
      data,
      pagination: {
        page,
        per_page,
        total,
        total_pages: Math.ceil(total / per_page),
        has_next: page * per_page < total,
      },
    });
  });
}

function filterMatchedTechs(techProfile, { uses, uses_any, min_confidence }) {
  if (!Array.isArray(techProfile)) return [];
  const allTargets = new Set([...(uses || []), ...(uses_any || [])]);
  return techProfile
    .filter(t => allTargets.has(t.canonical) && t.confidence >= min_confidence)
    .map(t => ({ canonical: t.canonical, category: t.category, confidence: t.confidence }));
}
