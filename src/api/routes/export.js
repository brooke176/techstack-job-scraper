import { query } from '../../db/client.js';
import { z } from 'zod';

const exportSchema = z.object({
  format:         z.enum(['json', 'csv']).default('json'),
  domains:        z.array(z.string()).max(500).optional(),
  technology:     z.string().optional(),        // filter to companies using this tech
  category:       z.string().optional(),        // filter by category
  min_confidence: z.number().min(0).max(1).default(0.6),
  fields:         z.array(z.enum(['domain', 'name', 'technologies', 'categories', 'last_scraped', 'job_count'])).default(['domain', 'name', 'technologies', 'last_scraped']),
});

export async function exportRoutes(fastify) {
  // POST /export
  // Returns a CSV or JSON bulk export
  // Pro/Enterprise plans only (checked via apiKey.plan)
  fastify.post('/', async (request, reply) => {
    // Plan check
    const plan = request.apiKey?.plan;
    if (plan === 'starter') {
      return reply.code(403).send({
        error: 'plan_required',
        message: 'Bulk export requires a Pro or Enterprise plan. Upgrade at https://techstackdata.io/pricing',
      });
    }

    const parse = exportSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({ error: 'invalid_params', message: parse.error.issues[0].message });
    }

    const { format, domains, technology, category, min_confidence, fields } = parse.data;

    // Enterprise gets up to 500 domains, Pro up to 100
    const domainLimit = plan === 'enterprise' ? 500 : 100;

    // Build query
    const conditions = [];
    const params = [min_confidence];

    if (domains && domains.length > 0) {
      const limitedDomains = domains.slice(0, domainLimit);
      params.push(limitedDomains);
      conditions.push(`p.domain = ANY($${params.length})`);
    }

    if (technology) {
      params.push(technology);
      conditions.push(
        `EXISTS (
          SELECT 1 FROM jsonb_array_elements(p.tech_profile) AS t
          WHERE t->>'canonical' = $${params.length}
          AND (t->>'confidence')::float >= $1
        )`
      );
    }

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

    params.push(domainLimit);

    const sql = `
      WITH latest_profiles AS (
        SELECT DISTINCT ON (p.domain) p.domain, p.tech_profile, p.scraped_at, p.job_count
        FROM company_tech_profiles p
        ORDER BY p.domain, p.scraped_at DESC
      )
      SELECT p.domain, c.name, p.tech_profile, p.scraped_at, p.job_count
      FROM latest_profiles p
      JOIN companies c ON c.domain = p.domain
      ${whereClause}
      ORDER BY p.scraped_at DESC
      LIMIT $${params.length}
    `;

    const result = await query(sql, params);

    // Shape each row
    const rows = result.rows.map(row => {
      const techs = Array.isArray(row.tech_profile)
        ? row.tech_profile.filter(t => t.confidence >= min_confidence)
        : [];

      const shaped = {};
      if (fields.includes('domain'))       shaped.domain = row.domain;
      if (fields.includes('name'))         shaped.name = row.name;
      if (fields.includes('last_scraped')) shaped.last_scraped = row.scraped_at;
      if (fields.includes('job_count'))    shaped.job_count = row.job_count;
      if (fields.includes('technologies')) shaped.technologies = techs.map(t => t.canonical).join(', ');
      if (fields.includes('categories')) {
        const cats = {};
        for (const t of techs) {
          if (!cats[t.category]) cats[t.category] = [];
          cats[t.category].push(t.canonical);
        }
        shaped.categories = cats;
      }
      return shaped;
    });

    if (format === 'csv') {
      const csv = toCSV(rows, fields);
      return reply
        .code(200)
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', `attachment; filename="techstack-export-${Date.now()}.csv"`)
        .send(csv);
    }

    return reply.code(200).send({
      exported_at: new Date().toISOString(),
      count: rows.length,
      filters: { technology, category, min_confidence },
      data: rows,
    });
  });
}

function toCSV(rows, fields) {
  if (rows.length === 0) return fields.join(',') + '\n';

  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = fields.join(',');
  const csvRows = rows.map(row =>
    fields.map(f => escape(row[f])).join(',')
  );

  return [header, ...csvRows].join('\n') + '\n';
}
