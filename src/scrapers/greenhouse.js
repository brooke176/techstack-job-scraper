/**
 * Greenhouse scraper
 *
 * Greenhouse exposes a public JSON API for every company using it:
 *   https://boards-api.greenhouse.io/v1/boards/{company_token}/jobs?content=true
 *
 * This is the cleanest possible data source — structured JSON, no HTML parsing,
 * no bot detection. Start here before tackling harder sources.
 */

import { fetchJson } from '../utils/http-client.js';
import { logger } from '../utils/logger.js';
import { extractTechMentions } from '../enrichment/normalizer.js';

const GREENHOUSE_API_BASE = 'https://boards-api.greenhouse.io/v1/boards';

/**
 * Known Greenhouse board tokens for companies we want to track.
 * Format: { companyName, domain, greenhouseToken }
 *
 * To find a token: go to a company's Greenhouse jobs page, check the URL or
 * look for `greenhouse.io/embed/job_board?for=<TOKEN>` in their careers page HTML.
 */
export const GREENHOUSE_COMPANIES = [
  { companyName: 'Stripe', domain: 'stripe.com', token: 'stripe' },
  { companyName: 'Airbnb', domain: 'airbnb.com', token: 'airbnb' },
  { companyName: 'Figma', domain: 'figma.com', token: 'figma' },
  { companyName: 'Notion', domain: 'notion.so', token: 'notion' },
  { companyName: 'Linear', domain: 'linear.app', token: 'linear' },
  { companyName: 'Vercel', domain: 'vercel.com', token: 'vercel' },
  { companyName: 'Supabase', domain: 'supabase.com', token: 'supabase' },
  { companyName: 'PlanetScale', domain: 'planetscale.com', token: 'planetscale' },
  { companyName: 'Retool', domain: 'retool.com', token: 'retool' },
  { companyName: 'Airtable', domain: 'airtable.com', token: 'airtable' },
  { companyName: 'Loom', domain: 'loom.com', token: 'loom' },
  { companyName: 'Rippling', domain: 'rippling.com', token: 'rippling' },
  { companyName: 'Brex', domain: 'brex.com', token: 'brex' },
  { companyName: 'Mercury', domain: 'mercury.com', token: 'mercury' },
  { companyName: 'Ramp', domain: 'ramp.com', token: 'ramp' },
];

/**
 * Fetch all jobs for a single company from Greenhouse.
 * Returns structured job objects ready for tech extraction.
 */
export async function fetchGreenhouseJobs(companyEntry) {
  const { companyName, domain, token } = companyEntry;
  const url = `${GREENHOUSE_API_BASE}/${token}/jobs?content=true`;

  logger.info(`Fetching Greenhouse jobs`, { company: companyName, url });

  let data;
  try {
    data = await fetchJson(url);
  } catch (err) {
    logger.error(`Failed to fetch Greenhouse jobs`, { company: companyName, error: err.message });
    return null;
  }

  if (!data?.jobs || !Array.isArray(data.jobs)) {
    logger.warn(`No jobs array in Greenhouse response`, { company: companyName });
    return null;
  }

  logger.info(`Fetched jobs from Greenhouse`, { company: companyName, count: data.jobs.length });

  const jobs = data.jobs.map(job => ({
    id: String(job.id),
    title: job.title || '',
    // Greenhouse returns HTML content — strip tags for text extraction
    description: stripHtml(job.content || ''),
    location: job.location?.name || '',
    department: job.departments?.[0]?.name || '',
    url: job.absolute_url || `https://boards.greenhouse.io/${token}/jobs/${job.id}`,
    postedAt: job.updated_at || null,
  }));

  const techMentions = jobs.flatMap(job =>
    extractTechMentions(`${job.title} ${job.description}`)
  );

  // Deduplicate tech mentions across all jobs
  const techSet = new Map();
  for (const tech of techMentions) {
    if (!techSet.has(tech.canonical)) {
      techSet.set(tech.canonical, { ...tech, count: 1 });
    } else {
      techSet.get(tech.canonical).count++;
    }
  }

  return {
    companyName,
    domain,
    source: 'greenhouse',
    scrapedAt: new Date().toISOString(),
    jobCount: jobs.length,
    jobs,
    techStack: Array.from(techSet.values()).sort((a, b) => b.count - a.count),
  };
}

/**
 * Scrape all companies in the list, respecting concurrency limits.
 */
export async function scrapeAllGreenhouse(companies = GREENHOUSE_COMPANIES, options = {}) {
  const { concurrency = 3 } = options;
  const results = [];
  const errors = [];

  logger.info(`Starting Greenhouse scrape`, { total: companies.length, concurrency });

  // Process in batches to respect rate limits
  for (let i = 0; i < companies.length; i += concurrency) {
    const batch = companies.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(company => fetchGreenhouseJobs(company))
    );

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      const company = batch[j];

      if (result.status === 'fulfilled' && result.value) {
        results.push(result.value);
        logger.info(`Completed`, {
          company: company.companyName,
          jobs: result.value.jobCount,
          techCount: result.value.techStack.length,
        });
      } else {
        const error = result.reason?.message || 'Unknown error';
        errors.push({ company: company.companyName, error });
        logger.error(`Failed`, { company: company.companyName, error });
      }
    }

    // Small pause between batches
    if (i + concurrency < companies.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  logger.info(`Greenhouse scrape complete`, {
    succeeded: results.length,
    failed: errors.length,
  });

  return { results, errors };
}

/**
 * Discover the Greenhouse token for a company from their careers page HTML.
 * Useful for expanding the company list programmatically.
 */
export async function discoverGreenhouseToken(careersUrl) {
  const { fetchPage } = await import('../utils/http-client.js');
  const { load } = await import('cheerio');

  try {
    const { html } = await fetchPage(careersUrl);
    const $ = load(html);

    // Look for greenhouse embed URLs
    let token = null;

    $('script[src*="greenhouse.io"], iframe[src*="greenhouse.io"], a[href*="greenhouse.io"]').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('href') || '';
      const match = src.match(/greenhouse\.io\/(?:embed\/job_board\?for=|jobs\/)([a-z0-9_-]+)/i);
      if (match) token = match[1];
    });

    // Also search raw HTML for the pattern
    if (!token) {
      const match = html.match(/greenhouse\.io\/(?:embed\/job_board\?for=|boards\/)([a-z0-9_-]+)/i);
      if (match) token = match[1];
    }

    return token;
  } catch (err) {
    logger.warn(`Could not discover Greenhouse token`, { url: careersUrl, error: err.message });
    return null;
  }
}

/**
 * Strip HTML tags and decode common entities for clean text extraction.
 */
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
