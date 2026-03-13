/**
 * BullMQ worker
 *
 * Processes jobs from scrape-jobs queue, routes results to enrich-results queue.
 * Run this as a separate process: `node src/queue/worker.js`
 */

import { Worker } from 'bullmq';
import { connection, enrichQueue, storeQueue } from './queues.js';
import { fetchGreenhouseJobs } from '../scrapers/greenhouse.js';
import { fetchLeverJobs } from '../scrapers/lever.js';
import { scrapeIndeedForCompany } from '../scrapers/indeed.js';
import { scrapeHeadersForDomain } from '../scrapers/headers.js';
import { buildTechProfileFromJobs, normalizeTechSignals } from '../enrichment/normalizer.js';
import { query } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

/**
 * Main scrape job processor.
 * Routes to the right scraper based on job.data.source.
 */
async function processScrapeJob(job) {
  const { source, companyName, domain } = job.data;
  logger.info(`Processing scrape job`, { jobId: job.id, company: companyName, source });

  let rawResult = null;

  switch (source) {
    case 'greenhouse':
      rawResult = await fetchGreenhouseJobs(job.data);
      break;

    case 'lever':
      rawResult = await fetchLeverJobs(job.data);
      break;

    case 'indeed':
      rawResult = await scrapeIndeedForCompany(job.data);
      break;

    case 'html_headers':
      rawResult = await scrapeHeadersForDomain(job.data);
      break;

    case 'full_run':
      // Triggered by the cron job — schedules individual company scrapes
      await scheduleFullScrapeRun();
      return { scheduled: true };

    default:
      throw new Error(`Unknown source type: ${source}`);
  }

  if (!rawResult) {
    logger.warn(`Scraper returned no data`, { company: companyName, source });
    return { skipped: true, reason: 'no_data' };
  }

  // Build normalized tech profile from jobs
  const techProfile = buildTechProfileFromJobs(rawResult.jobs);

  const enrichedResult = {
    companyName: rawResult.companyName,
    domain: rawResult.domain,
    source: rawResult.source,
    scrapedAt: rawResult.scrapedAt,
    jobCount: rawResult.jobCount,
    techProfile,
    rawTechStack: rawResult.techStack,
  };

  // Push to store queue (skip enrich queue since we're doing enrichment inline here)
  await storeQueue.add(`store:${domain}`, enrichedResult);

  logger.info(`Scrape job complete, queued for storage`, {
    company: companyName,
    techCount: techProfile.length,
    jobCount: rawResult.jobCount,
  });

  return {
    company: companyName,
    techCount: techProfile.length,
    jobCount: rawResult.jobCount,
  };
}

/**
 * Store job processor — persists results to Postgres (or logs to file in dev).
 */
async function processStoreJob(job) {
  const { companyName, domain, techProfile, scrapedAt, source, jobCount } = job.data;

  logger.info(`Storing results`, { company: companyName, techCount: techProfile?.length });

  // Upsert company row
  await query(
    `INSERT INTO companies (domain, name)
     VALUES ($1, $2)
     ON CONFLICT (domain) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
    [domain, companyName]
  );

  // Fetch previous tech profile to detect changes
  const prevResult = await query(
    `SELECT tech_profile FROM company_tech_profiles
     WHERE domain = $1 AND source = $2
     ORDER BY scraped_at DESC LIMIT 1`,
    [domain, source]
  );
  const prevTechs = new Map(
    (prevResult.rows[0]?.tech_profile || []).map(t => [t.canonical, t])
  );

  // Upsert tech profile
  await query(
    `INSERT INTO company_tech_profiles
       (domain, source, job_count, tech_count, tech_profile, scraped_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (domain, source) DO UPDATE
       SET job_count   = EXCLUDED.job_count,
           tech_count  = EXCLUDED.tech_count,
           tech_profile = EXCLUDED.tech_profile,
           scraped_at  = EXCLUDED.scraped_at,
           updated_at  = NOW()`,
    [domain, source, jobCount, techProfile?.length || 0, JSON.stringify(techProfile || []), scrapedAt]
  );

  // Record change events
  if (techProfile && techProfile.length > 0) {
    const currentTechs = new Map(techProfile.map(t => [t.canonical, t]));

    // Detect added techs
    for (const [canonical, tech] of currentTechs) {
      if (!prevTechs.has(canonical)) {
        await query(
          `INSERT INTO tech_change_events (domain, event_type, canonical, category, new_confidence)
           VALUES ($1, 'added', $2, $3, $4)`,
          [domain, canonical, tech.category, tech.confidence]
        ).catch(() => {}); // non-fatal
      }
    }

    // Detect removed techs
    for (const [canonical, tech] of prevTechs) {
      if (!currentTechs.has(canonical)) {
        await query(
          `INSERT INTO tech_change_events (domain, event_type, canonical, category, old_confidence)
           VALUES ($1, 'removed', $2, $3, $4)`,
          [domain, canonical, tech.category, tech.confidence]
        ).catch(() => {}); // non-fatal
      }
    }
  }

  logger.info(`Stored to DB`, { domain, source, techCount: techProfile?.length || 0 });

  return { stored: true, domain };
}

// Create workers
const scrapeWorker = new Worker('scrape-jobs', processScrapeJob, {
  connection,
  concurrency: config.scraping.concurrencyLimit,
  limiter: {
    max: 10,
    duration: 60 * 1000, // max 10 jobs per minute
  },
});

const storeWorker = new Worker('store-results', processStoreJob, {
  connection,
  concurrency: 5,
});

// Worker event handlers
scrapeWorker.on('completed', (job, result) => {
  logger.info(`Scrape worker: job completed`, { jobId: job.id, result });
});

scrapeWorker.on('failed', (job, err) => {
  logger.error(`Scrape worker: job failed`, {
    jobId: job?.id,
    name: job?.name,
    attempts: job?.attemptsMade,
    error: err.message,
  });
});

scrapeWorker.on('stalled', (jobId) => {
  logger.warn(`Scrape worker: job stalled`, { jobId });
});

storeWorker.on('failed', (job, err) => {
  logger.error(`Store worker: job failed`, { jobId: job?.id, error: err.message });
});

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down workers...');
  await scrapeWorker.close();
  await storeWorker.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

logger.info('Workers started', {
  scrapeWorker: 'scrape-jobs',
  storeWorker: 'store-results',
  concurrency: config.scraping.concurrencyLimit,
});

// Import after workers are defined to avoid circular deps
async function scheduleFullScrapeRun() {
  const { scheduleFullScrapeRun: schedule } = await import('./queues.js');
  return schedule();
}
