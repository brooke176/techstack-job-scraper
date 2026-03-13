/**
 * Lever scraper
 *
 * Lever also exposes a public JSON API:
 *   https://api.lever.co/v0/postings/{company_slug}?mode=json
 *
 * Individual job content:
 *   https://api.lever.co/v0/postings/{company_slug}/{id}?mode=json
 */

import { fetchJson } from '../utils/http-client.js';
import { logger } from '../utils/logger.js';
import { extractTechMentions } from '../enrichment/normalizer.js';

const LEVER_API_BASE = 'https://api.lever.co/v0/postings';

export const LEVER_COMPANIES = [
  { companyName: 'Plaid', domain: 'plaid.com', slug: 'plaid' },
  { companyName: 'Clubhouse', domain: 'shortcut.com', slug: 'shortcut' },
  { companyName: 'Miro', domain: 'miro.com', slug: 'miro' },
  { companyName: 'Intercom', domain: 'intercom.com', slug: 'intercom' },
  { companyName: 'Amplitude', domain: 'amplitude.com', slug: 'amplitude' },
  { companyName: 'Segment', domain: 'segment.com', slug: 'segment' },
  { companyName: 'LaunchDarkly', domain: 'launchdarkly.com', slug: 'launchdarkly' },
  { companyName: 'Zapier', domain: 'zapier.com', slug: 'zapier' },
  { companyName: 'Asana', domain: 'asana.com', slug: 'asana' },
  { companyName: 'Mixpanel', domain: 'mixpanel.com', slug: 'mixpanel' },
  { companyName: 'Datadog', domain: 'datadoghq.com', slug: 'datadog' },
  { companyName: 'HashiCorp', domain: 'hashicorp.com', slug: 'hashicorp' },
  { companyName: 'Grafana Labs', domain: 'grafana.com', slug: 'grafana' },
  { companyName: 'Sourcegraph', domain: 'sourcegraph.com', slug: 'sourcegraph' },
];

/**
 * Fetch all job postings for a company from Lever's API.
 */
export async function fetchLeverJobs(companyEntry) {
  const { companyName, domain, slug } = companyEntry;
  const url = `${LEVER_API_BASE}/${slug}?mode=json`;

  logger.info(`Fetching Lever jobs`, { company: companyName });

  let data;
  try {
    data = await fetchJson(url);
  } catch (err) {
    logger.error(`Failed to fetch Lever jobs`, { company: companyName, error: err.message });
    return null;
  }

  if (!Array.isArray(data)) {
    logger.warn(`Unexpected Lever API response shape`, { company: companyName });
    return null;
  }

  logger.info(`Fetched Lever jobs`, { company: companyName, count: data.length });

  const jobs = data.map(posting => {
    // Lever's content is nested — concatenate all text blocks
    const descriptionParts = [];
    if (posting.descriptionPlain) descriptionParts.push(posting.descriptionPlain);
    if (posting.additionalPlain) descriptionParts.push(posting.additionalPlain);
    if (posting.lists) {
      for (const list of posting.lists) {
        if (list.text) descriptionParts.push(list.text);
        if (list.content) descriptionParts.push(stripHtml(list.content));
      }
    }

    return {
      id: posting.id,
      title: posting.text || '',
      description: descriptionParts.join(' '),
      location: posting.categories?.location || '',
      department: posting.categories?.department || '',
      team: posting.categories?.team || '',
      url: posting.hostedUrl || `https://jobs.lever.co/${slug}/${posting.id}`,
      postedAt: posting.createdAt ? new Date(posting.createdAt).toISOString() : null,
    };
  });

  const techSet = new Map();
  for (const job of jobs) {
    const techs = extractTechMentions(`${job.title} ${job.description}`);
    for (const tech of techs) {
      if (!techSet.has(tech.canonical)) {
        techSet.set(tech.canonical, { ...tech, count: 1 });
      } else {
        techSet.get(tech.canonical).count++;
      }
    }
  }

  return {
    companyName,
    domain,
    source: 'lever',
    scrapedAt: new Date().toISOString(),
    jobCount: jobs.length,
    jobs,
    techStack: Array.from(techSet.values()).sort((a, b) => b.count - a.count),
  };
}

/**
 * Scrape all Lever companies in batches.
 */
export async function scrapeAllLever(companies = LEVER_COMPANIES, options = {}) {
  const { concurrency = 3 } = options;
  const results = [];
  const errors = [];

  logger.info(`Starting Lever scrape`, { total: companies.length, concurrency });

  for (let i = 0; i < companies.length; i += concurrency) {
    const batch = companies.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(company => fetchLeverJobs(company))
    );

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      const company = batch[j];

      if (result.status === 'fulfilled' && result.value) {
        results.push(result.value);
        logger.info(`Lever complete`, {
          company: company.companyName,
          jobs: result.value.jobCount,
          techCount: result.value.techStack.length,
        });
      } else {
        const error = result.reason?.message || 'Unknown error';
        errors.push({ company: company.companyName, error });
        logger.error(`Lever failed`, { company: company.companyName, error });
      }
    }

    if (i + concurrency < companies.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  logger.info(`Lever scrape complete`, { succeeded: results.length, failed: errors.length });
  return { results, errors };
}

/**
 * Discover Lever slug from a careers page URL.
 */
export async function discoverLeverSlug(careersUrl) {
  const { fetchPage } = await import('../utils/http-client.js');

  try {
    const { html } = await fetchPage(careersUrl);
    const match = html.match(/jobs\.lever\.co\/([a-z0-9_-]+)/i);
    return match ? match[1] : null;
  } catch (err) {
    logger.warn(`Could not discover Lever slug`, { url: careersUrl, error: err.message });
    return null;
  }
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
