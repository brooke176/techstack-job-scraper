/**
 * Indeed scraper
 *
 * Used for companies not on Greenhouse/Lever that post directly to Indeed.
 * This involves real HTML scraping so it's more brittle — use ATS APIs first.
 *
 * Strategy:
 *   1. Search Indeed for `"[company name]" jobs` with employer filter
 *   2. Extract job listings from search results page
 *   3. Fetch individual job pages for full descriptions
 *   4. Extract tech mentions from full descriptions
 *
 * Note: Indeed has bot detection. In production you need rotating proxies.
 * This implementation includes the structure — plug in your proxy config.
 */

import * as cheerio from 'cheerio';
import { fetchPage } from '../utils/http-client.js';
import { logger } from '../utils/logger.js';
import { extractTechMentions } from '../enrichment/normalizer.js';

const INDEED_BASE = 'https://www.indeed.com';

/**
 * Search Indeed for jobs at a specific company.
 * Returns job listings with titles, URLs, and snippets.
 */
export async function searchIndeedJobs(companyName, options = {}) {
  const { maxJobs = 50, location = '' } = options;

  const searchQuery = encodeURIComponent(`"${companyName}"`);
  const locationQuery = location ? `&l=${encodeURIComponent(location)}` : '';
  const url = `${INDEED_BASE}/jobs?q=${searchQuery}&sc=0kf%3Aattr(DSQF7)%3B&sort=date${locationQuery}`;

  logger.info(`Searching Indeed`, { company: companyName, url });

  let html;
  try {
    const response = await fetchPage(url);
    html = response.html;
  } catch (err) {
    logger.error(`Indeed search failed`, { company: companyName, error: err.message });
    return [];
  }

  const $ = cheerio.load(html);
  const jobLinks = [];

  // Indeed job cards — selector targets the job title anchor
  $('a[data-jk], a[id^="job_"]').each((_, el) => {
    const href = $(el).attr('href');
    const title = $(el).text().trim();

    if (href && title && jobLinks.length < maxJobs) {
      const fullUrl = href.startsWith('http') ? href : `${INDEED_BASE}${href}`;
      const jk = href.match(/[?&]jk=([a-z0-9]+)/i)?.[1];
      if (jk) {
        jobLinks.push({ url: fullUrl, title, jk });
      }
    }
  });

  // Fallback: look for mosaic job cards
  if (jobLinks.length === 0) {
    $('[class*="jobTitle"] a, [data-testid="job-title"] a').each((_, el) => {
      const href = $(el).attr('href');
      const title = $(el).text().trim();
      if (href && title && jobLinks.length < maxJobs) {
        const fullUrl = href.startsWith('http') ? href : `${INDEED_BASE}${href}`;
        jobLinks.push({ url: fullUrl, title });
      }
    });
  }

  logger.info(`Found Indeed job links`, { company: companyName, count: jobLinks.length });
  return jobLinks;
}

/**
 * Fetch a single Indeed job page and extract the full description.
 */
export async function fetchIndeedJobDescription(jobUrl) {
  let html;
  try {
    const response = await fetchPage(jobUrl, { delayMs: 3000 });
    html = response.html;
  } catch (err) {
    logger.warn(`Failed to fetch Indeed job`, { url: jobUrl, error: err.message });
    return null;
  }

  const $ = cheerio.load(html);

  // Try multiple selectors — Indeed changes their DOM frequently
  const descriptionSelectors = [
    '[data-testid="jobsearch-JobComponent-description"]',
    '#jobDescriptionText',
    '.jobsearch-jobDescriptionText',
    '[class*="jobDescription"]',
    '.job-description',
  ];

  let description = '';
  for (const selector of descriptionSelectors) {
    const el = $(selector);
    if (el.length) {
      description = el.text().replace(/\s{2,}/g, ' ').trim();
      break;
    }
  }

  // Extract job title
  const titleSelectors = [
    '[data-testid="jobTitle"]',
    '.jobsearch-JobInfoHeader-title',
    'h1[class*="title"]',
    'h1',
  ];

  let title = '';
  for (const selector of titleSelectors) {
    const el = $(selector).first();
    if (el.length) {
      title = el.text().trim();
      break;
    }
  }

  // Extract company name from page (verify we got the right company)
  const companyEl = $('[data-testid="inlineHeader-companyName"], .jobsearch-InlineCompanyRating-companyHeader').first();
  const pageCompanyName = companyEl.text().trim();

  if (!description) {
    logger.warn(`No description found on Indeed job page`, { url: jobUrl });
    return null;
  }

  return { title, description, company: pageCompanyName, url: jobUrl };
}

/**
 * Full pipeline: search Indeed for a company, fetch job descriptions, extract tech.
 */
export async function scrapeIndeedForCompany(companyEntry, options = {}) {
  const { companyName, domain } = companyEntry;
  const { maxJobs = 20 } = options; // Keep low to avoid rate limiting

  const jobLinks = await searchIndeedJobs(companyName, { maxJobs });

  if (jobLinks.length === 0) {
    logger.warn(`No Indeed jobs found`, { company: companyName });
    return null;
  }

  // Fetch full descriptions for first N jobs (don't hammer Indeed)
  const jobsToFetch = jobLinks.slice(0, Math.min(maxJobs, 15));
  const jobs = [];

  for (const link of jobsToFetch) {
    const jobDetail = await fetchIndeedJobDescription(link.url);
    if (jobDetail) {
      jobs.push({
        id: link.jk || link.url,
        title: jobDetail.title || link.title,
        description: jobDetail.description,
        url: link.url,
        source: 'indeed',
      });
    }
    // Longer delay between full page fetches
    await new Promise(r => setTimeout(r, 2500 + Math.random() * 1500));
  }

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
    source: 'indeed',
    scrapedAt: new Date().toISOString(),
    jobCount: jobs.length,
    jobs,
    techStack: Array.from(techSet.values()).sort((a, b) => b.count - a.count),
  };
}

/**
 * Parse pagination from an Indeed search results page.
 * Useful for companies with many postings.
 */
export function parseIndeedPagination(html) {
  const $ = cheerio.load(html);
  const pages = [];

  $('nav[aria-label="pagination"] a, [data-testid="pagination"] a').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href && /^\d+$/.test(text)) {
      pages.push({
        page: parseInt(text),
        url: href.startsWith('http') ? href : `${INDEED_BASE}${href}`,
      });
    }
  });

  return pages;
}
