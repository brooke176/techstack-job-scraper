import { query } from '../../db/client.js';
import { z } from 'zod';

const domainSchema = z.string()
  .min(3)
  .max(253)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,}$/, 'Invalid domain format');

const querySchema = z.object({
  sources: z.string().optional(),       // comma-separated: greenhouse,lever,indeed,html_headers
  category: z.string().optional(),      // frontend | backend | devops | database | ...
  min_confidence: z.coerce.number().min(0).max(1).optional(),
  include_history: z.enum(['true', 'false']).optional().default('false'),
}).strict();

export async function companyRoutes(fastify) {
  // GET /company/:domain
  fastify.get('/:domain', async (request, reply) => {
    // Validate domain param
    const domainParse = domainSchema.safeParse(request.params.domain);
    if (!domainParse.success) {
      return reply.code(400).send({
        error: 'invalid_domain',
        message: domainParse.error.issues[0].message,
      });
    }

    // Validate query params
    const queryParse = querySchema.safeParse(request.query);
    if (!queryParse.success) {
      return reply.code(400).send({
        error: 'invalid_params',
        message: queryParse.error.issues[0].message,
      });
    }

    const domain = domainParse.data.toLowerCase();
    const { sources, category, min_confidence, include_history } = queryParse.data;

    // Look up company
    const companyResult = await query(
      'SELECT id, name, domain, created_at FROM companies WHERE domain = $1',
      [domain]
    );

    if (companyResult.rows.length === 0) {
      return reply.code(404).send({
        error: 'not_found',
        message: `No data found for domain: ${domain}`,
        hint: 'This domain has not been scraped yet. Check /companies for available domains.',
      });
    }

    const company = companyResult.rows[0];

    // Build source filter
    let sourceFilter = '';
    const params = [domain];
    if (sources) {
      const allowedSources = ['greenhouse', 'lever', 'indeed', 'html_headers'];
      const requestedSources = sources.split(',').map(s => s.trim()).filter(s => allowedSources.includes(s));
      if (requestedSources.length > 0) {
        params.push(requestedSources);
        sourceFilter = `AND source = ANY($${params.length})`;
      }
    }

    // Fetch all tech profiles for this domain
    const profileResult = await query(
      `SELECT source, job_count, tech_count, tech_profile, scraped_at
       FROM company_tech_profiles
       WHERE domain = $1 ${sourceFilter}
       ORDER BY scraped_at DESC`,
      params
    );

    if (profileResult.rows.length === 0) {
      return reply.code(404).send({
        error: 'no_profile',
        message: `Company ${domain} exists but has no tech profile data yet.`,
      });
    }

    // Merge tech profiles across sources
    const merged = mergeTechProfiles(profileResult.rows);

    // Apply filters
    let technologies = merged.technologies;

    if (category) {
      technologies = technologies.filter(t => t.category === category);
    }

    if (min_confidence !== undefined) {
      technologies = technologies.filter(t => t.confidence >= min_confidence);
    }

    // Sort by confidence desc
    technologies.sort((a, b) => b.confidence - a.confidence);

    // Group by category for convenience
    const byCategory = {};
    for (const tech of technologies) {
      if (!byCategory[tech.category]) byCategory[tech.category] = [];
      byCategory[tech.category].push(tech);
    }

    const response = {
      domain,
      company: company.name,
      tech_count: technologies.length,
      last_scraped: merged.lastScraped,
      sources_available: profileResult.rows.map(r => r.source),
      technologies,
      by_category: byCategory,
    };

    // Optionally include change history
    if (include_history === 'true') {
      const historyResult = await query(
        `SELECT event_type, canonical, category, old_confidence, new_confidence, detected_at
         FROM tech_change_events
         WHERE domain = $1
         ORDER BY detected_at DESC
         LIMIT 100`,
        [domain]
      );
      response.history = historyResult.rows;
    }

    return reply.code(200).send(response);
  });
}

/**
 * Merge tech profiles from multiple sources.
 * If the same technology appears in multiple sources, boost confidence
 * and combine sources array.
 */
function mergeTechProfiles(profileRows) {
  const techMap = new Map(); // canonical -> merged entry
  let lastScraped = null;

  for (const row of profileRows) {
    if (!lastScraped || new Date(row.scraped_at) > new Date(lastScraped)) {
      lastScraped = row.scraped_at;
    }

    const techs = Array.isArray(row.tech_profile) ? row.tech_profile : [];

    for (const tech of techs) {
      const key = tech.canonical;
      if (!techMap.has(key)) {
        techMap.set(key, {
          canonical: tech.canonical,
          category: tech.category,
          confidence: tech.confidence,
          sources: [...(tech.sources || [])],
          job_mention_count: tech.jobMentionCount || 0,
          job_mention_frequency: tech.jobMentionFrequency || 0,
        });
      } else {
        const existing = techMap.get(key);
        // Multi-source confidence boost: +0.05 per additional source, cap at 0.99
        existing.confidence = Math.min(0.99, existing.confidence + 0.05);
        // Merge sources
        for (const src of (tech.sources || [])) {
          if (!existing.sources.includes(src)) existing.sources.push(src);
        }
        // Take the higher job mention stats
        existing.job_mention_count = Math.max(existing.job_mention_count, tech.jobMentionCount || 0);
        existing.job_mention_frequency = Math.max(existing.job_mention_frequency, tech.jobMentionFrequency || 0);
      }
    }
  }

  return {
    technologies: Array.from(techMap.values()),
    lastScraped,
  };
}
