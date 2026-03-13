/**
 * Main entry point for running scrapers directly (without Redis/queue).
 * Good for development, testing, and initial data collection.
 *
 * Usage:
 *   node src/index.js                    # scrape all sources
 *   node src/index.js --source greenhouse # greenhouse only
 *   node src/index.js --source lever      # lever only
 *   node src/index.js --domain stripe.com # single company
 */

import { scrapeAllGreenhouse, GREENHOUSE_COMPANIES } from './scrapers/greenhouse.js';
import { scrapeAllLever, LEVER_COMPANIES } from './scrapers/lever.js';
import { buildTechProfileFromJobs, groupByCategory } from './enrichment/normalizer.js';
import { logger } from './utils/logger.js';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const sourceArg = args.find(a => a.startsWith('--source='))?.split('=')[1];
const domainArg = args.find(a => a.startsWith('--domain='))?.split('=')[1];
const outputDir = './data';

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

async function run() {
  const startedAt = new Date().toISOString();
  logger.info('Starting scrape run', { source: sourceArg || 'all', domain: domainArg || 'all' });

  const allResults = [];

  // --- Greenhouse ---
  if (!sourceArg || sourceArg === 'greenhouse') {
    const companies = domainArg
      ? GREENHOUSE_COMPANIES.filter(c => c.domain === domainArg)
      : GREENHOUSE_COMPANIES;

    if (companies.length > 0) {
      logger.info(`Running Greenhouse scraper`, { count: companies.length });
      const { results, errors } = await scrapeAllGreenhouse(companies, { concurrency: 3 });
      allResults.push(...results);

      if (errors.length > 0) {
        logger.warn('Greenhouse errors', { errors });
      }
    }
  }

  // --- Lever ---
  if (!sourceArg || sourceArg === 'lever') {
    const companies = domainArg
      ? LEVER_COMPANIES.filter(c => c.domain === domainArg)
      : LEVER_COMPANIES;

    if (companies.length > 0) {
      logger.info(`Running Lever scraper`, { count: companies.length });
      const { results, errors } = await scrapeAllLever(companies, { concurrency: 3 });
      allResults.push(...results);

      if (errors.length > 0) {
        logger.warn('Lever errors', { errors });
      }
    }
  }

  // --- Enrich and summarize ---
  const enriched = allResults.map(result => {
    const techProfile = buildTechProfileFromJobs(result.jobs || []);
    const byCategory = groupByCategory(techProfile);

    return {
      companyName: result.companyName,
      domain: result.domain,
      source: result.source,
      scrapedAt: result.scrapedAt,
      jobCount: result.jobCount,
      techCount: techProfile.length,
      techProfile,
      byCategory,
      topTech: techProfile.slice(0, 15).map(t => ({
        name: t.canonical,
        category: t.category,
        confidence: Math.round(t.confidence * 100) / 100,
        jobMentions: t.jobMentionCount,
      })),
    };
  });

  // --- Save results ---
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFile = path.join(outputDir, `scrape-${timestamp}.json`);

  const output = {
    runAt: startedAt,
    completedAt: new Date().toISOString(),
    totalCompanies: enriched.length,
    totalJobs: enriched.reduce((sum, r) => sum + (r.jobCount || 0), 0),
    results: enriched,
  };

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  logger.info(`Results saved`, { file: outputFile, companies: enriched.length });

  // --- Print summary to console ---
  console.log('\n' + '='.repeat(60));
  console.log('SCRAPE SUMMARY');
  console.log('='.repeat(60));

  for (const company of enriched) {
    console.log(`\n${company.companyName} (${company.domain})`);
    console.log(`  Jobs: ${company.jobCount} | Tech detected: ${company.techCount}`);
    if (company.topTech.length > 0) {
      console.log(`  Top tech:`);
      for (const tech of company.topTech.slice(0, 8)) {
        const bar = '█'.repeat(Math.round(tech.confidence * 10));
        console.log(`    ${tech.name.padEnd(20)} ${bar} ${Math.round(tech.confidence * 100)}% (${tech.jobMentions} jobs)`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Total: ${enriched.length} companies, ${output.totalJobs} jobs`);
  console.log(`Output: ${outputFile}`);

  return output;
}

run().catch(err => {
  logger.error('Scrape run failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
