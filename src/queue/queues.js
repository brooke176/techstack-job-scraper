/**
 * Queue definitions using BullMQ.
 *
 * Queues:
 *   - scrape-jobs: one job per company, routes to the right scraper
 *   - enrich-results: processes raw scraped data through the normalizer
 *   - store-results: persists normalized data to Postgres
 */

import { Queue, Worker, QueueEvents } from 'bullmq';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const connection = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
};

// Queue declarations
export const scrapeQueue = new Queue('scrape-jobs', {
  connection,
  defaultJobOptions: {
    attempts: config.scraping.maxRetries,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000, age: 60 * 60 * 24 }, // keep 24h
    removeOnFail: { count: 500, age: 60 * 60 * 24 * 7 },  // keep failures 7d
  },
});

export const enrichQueue = new Queue('enrich-results', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 2000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
});

export const storeQueue = new Queue('store-results', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 500 },
  },
});

/**
 * Job types and their payloads
 *
 * scrape-jobs payload:
 *   { companyName, domain, source: 'greenhouse'|'lever'|'indeed', token/slug }
 *
 * enrich-results payload:
 *   { rawResult: { companyName, domain, source, jobs[], scrapedAt } }
 *
 * store-results payload:
 *   { companyName, domain, normalizedTechStack[], scrapedAt, source }
 */

/**
 * Schedule a full scrape run for all configured companies.
 * Adds one job per company per source type.
 */
export async function scheduleFullScrapeRun() {
  const { GREENHOUSE_COMPANIES } = await import('../scrapers/greenhouse.js');
  const { LEVER_COMPANIES } = await import('../scrapers/lever.js');

  const jobs = [
    ...GREENHOUSE_COMPANIES.map(c => ({
      name: `greenhouse:${c.domain}`,
      data: { ...c, source: 'greenhouse' },
    })),
    ...LEVER_COMPANIES.map(c => ({
      name: `lever:${c.domain}`,
      data: { ...c, source: 'lever' },
    })),
  ];

  await scrapeQueue.addBulk(jobs);
  logger.info(`Scheduled scrape run`, { jobCount: jobs.length });
  return jobs.length;
}

/**
 * Schedule recurring scrape runs.
 * Greenhouse/Lever: daily (job listings change frequently)
 * HTML headers: weekly (tech stacks change slowly)
 */
export async function scheduleRecurringJobs() {
  // Daily scrape at 2am UTC
  await scrapeQueue.add(
    'scheduled-daily-scrape',
    { type: 'full_run', trigger: 'cron' },
    {
      repeat: { pattern: '0 2 * * *' },
      jobId: 'daily-scrape',
    }
  );

  logger.info('Recurring scrape jobs scheduled');
}

/**
 * Queue event listeners for monitoring and alerting.
 */
export function attachQueueMonitoring() {
  const scrapeEvents = new QueueEvents('scrape-jobs', { connection });

  scrapeEvents.on('completed', ({ jobId }) => {
    logger.debug('Scrape job completed', { jobId });
  });

  scrapeEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error('Scrape job failed', { jobId, failedReason });
  });

  scrapeEvents.on('stalled', ({ jobId }) => {
    logger.warn('Scrape job stalled', { jobId });
  });

  const enrichEvents = new QueueEvents('enrich-results', { connection });
  enrichEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error('Enrich job failed', { jobId, failedReason });
  });

  return { scrapeEvents, enrichEvents };
}

export { connection };
