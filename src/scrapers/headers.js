/**
 * HTTP Headers tech scraper
 *
 * Fetches a domain's HTTP response headers and extracts tech signals from:
 *   - Server, X-Powered-By, X-Generator, Via, X-Served-By, X-Backend, etc.
 *   - <meta name="generator"> in the HTML body
 *
 * These are typically 0.90–0.95 confidence signals (hard evidence, not inferred).
 * Run via: node src/scrapers/headers.js
 */

import axios from 'axios';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// Header → canonical tech mappings (lowercase match)
const HEADER_RULES = [
  // Server header
  { header: 'server', pattern: /nginx/i,          canonical: 'Nginx',        category: 'infrastructure' },
  { header: 'server', pattern: /apache/i,         canonical: 'Apache',       category: 'infrastructure' },
  { header: 'server', pattern: /caddy/i,          canonical: 'Caddy',        category: 'infrastructure' },
  { header: 'server', pattern: /cloudflare/i,     canonical: 'Cloudflare',   category: 'infrastructure' },
  { header: 'server', pattern: /fastly/i,         canonical: 'Fastly',       category: 'infrastructure' },
  { header: 'server', pattern: /envoy/i,          canonical: 'Envoy',        category: 'infrastructure' },
  { header: 'server', pattern: /istio/i,          canonical: 'Istio',        category: 'devops' },
  { header: 'server', pattern: /openresty/i,      canonical: 'OpenResty',    category: 'infrastructure' },
  { header: 'server', pattern: /microsoft-iis/i,  canonical: 'IIS',          category: 'infrastructure' },
  { header: 'server', pattern: /lighttpd/i,       canonical: 'Lighttpd',     category: 'infrastructure' },

  // X-Powered-By
  { header: 'x-powered-by', pattern: /php/i,         canonical: 'PHP',          category: 'language' },
  { header: 'x-powered-by', pattern: /express/i,     canonical: 'Express.js',   category: 'backend' },
  { header: 'x-powered-by', pattern: /next\.js/i,    canonical: 'Next.js',      category: 'frontend' },
  { header: 'x-powered-by', pattern: /asp\.net/i,    canonical: 'C#',           category: 'language' },
  { header: 'x-powered-by', pattern: /rails/i,       canonical: 'Ruby on Rails',category: 'backend' },
  { header: 'x-powered-by', pattern: /django/i,      canonical: 'Django',       category: 'backend' },
  { header: 'x-powered-by', pattern: /fastapi/i,     canonical: 'FastAPI',      category: 'backend' },
  { header: 'x-powered-by', pattern: /flask/i,       canonical: 'Flask',        category: 'backend' },
  { header: 'x-powered-by', pattern: /wordpress/i,   canonical: 'WordPress',    category: 'cms' },

  // X-Generator / X-CMS
  { header: 'x-generator',  pattern: /wordpress/i,   canonical: 'WordPress',    category: 'cms' },
  { header: 'x-generator',  pattern: /drupal/i,      canonical: 'Drupal',       category: 'cms' },
  { header: 'x-generator',  pattern: /joomla/i,      canonical: 'Joomla',       category: 'cms' },

  // CDN / Edge
  { header: 'x-served-by',  pattern: /fastly/i,      canonical: 'Fastly',       category: 'infrastructure' },
  { header: 'via',          pattern: /cloudfront/i,  canonical: 'AWS CloudFront',category: 'cloud' },
  { header: 'via',          pattern: /varnish/i,     canonical: 'Varnish',      category: 'infrastructure' },
  { header: 'cf-ray',       pattern: /.+/,           canonical: 'Cloudflare',   category: 'infrastructure' },

  // Vercel, Netlify, Heroku
  { header: 'x-vercel-id',  pattern: /.+/,           canonical: 'Vercel',       category: 'cloud' },
  { header: 'x-netlify',    pattern: /.+/,           canonical: 'Netlify',      category: 'cloud' },
  { header: 'x-request-id', pattern: /heroku/i,      canonical: 'Heroku',       category: 'cloud' },

  // AWS
  { header: 'x-amz-request-id', pattern: /.+/,       canonical: 'AWS',          category: 'cloud' },
  { header: 'x-amzn-requestid', pattern: /.+/,       canonical: 'AWS',          category: 'cloud' },

  // Kubernetes / envoy
  { header: 'x-envoy-upstream-service-time', pattern: /.+/, canonical: 'Envoy', category: 'infrastructure' },
];

// Meta tag generator patterns
const META_GENERATOR_RULES = [
  { pattern: /wordpress/i,  canonical: 'WordPress',    category: 'cms' },
  { pattern: /drupal/i,     canonical: 'Drupal',       category: 'cms' },
  { pattern: /joomla/i,     canonical: 'Joomla',       category: 'cms' },
  { pattern: /ghost/i,      canonical: 'Ghost',        category: 'cms' },
  { pattern: /shopify/i,    canonical: 'Shopify',      category: 'ecommerce' },
  { pattern: /squarespace/i,canonical: 'Squarespace',  category: 'cms' },
  { pattern: /wix/i,        canonical: 'Wix',          category: 'cms' },
  { pattern: /webflow/i,    canonical: 'Webflow',      category: 'cms' },
  { pattern: /gatsby/i,     canonical: 'Gatsby',       category: 'frontend' },
  { pattern: /hugo/i,       canonical: 'Hugo',         category: 'frontend' },
  { pattern: /jekyll/i,     canonical: 'Jekyll',       category: 'frontend' },
  { pattern: /next\.js/i,   canonical: 'Next.js',      category: 'frontend' },
];

/**
 * Scrape HTTP headers for a single domain.
 * @param {object} opts - { domain, companyName }
 * @returns scraped result shaped for the store queue
 */
export async function scrapeHeadersForDomain({ domain, companyName }) {
  const url = `https://${domain}`;
  const startTime = Date.now();

  let headers = {};
  let bodySnippet = '';

  try {
    const response = await axios.get(url, {
      timeout: 10_000,
      maxRedirects: 5,
      headers: {
        'User-Agent': config.scraping.userAgent,
        'Accept': 'text/html,application/xhtml+xml',
      },
      // Don't throw on non-2xx; we still want headers
      validateStatus: (status) => status < 600,
    });

    headers = response.headers || {};
    // Only grab the first 4KB for meta tag extraction
    bodySnippet = (typeof response.data === 'string' ? response.data : '').slice(0, 4096);
  } catch (err) {
    // Try HTTP fallback
    try {
      const fallbackUrl = `http://${domain}`;
      const response = await axios.get(fallbackUrl, {
        timeout: 8_000,
        maxRedirects: 3,
        headers: { 'User-Agent': config.scraping.userAgent },
        validateStatus: (status) => status < 600,
      });
      headers = response.headers || {};
      bodySnippet = (typeof response.data === 'string' ? response.data : '').slice(0, 4096);
    } catch {
      logger.warn('Header scraper: domain unreachable', { domain, err: err.message });
      return null;
    }
  }

  const signals = [];

  // Match header rules
  for (const rule of HEADER_RULES) {
    const value = headers[rule.header];
    if (value && rule.pattern.test(value)) {
      signals.push({
        canonical: rule.canonical,
        category: rule.category,
        confidence: 0.92,
        sources: ['http_headers'],
        jobMentionCount: 0,
        jobMentionFrequency: 0,
      });
    }
  }

  // Match meta generator tag
  const metaMatch = bodySnippet.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)
    || bodySnippet.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator["']/i);

  if (metaMatch) {
    const generatorValue = metaMatch[1];
    for (const rule of META_GENERATOR_RULES) {
      if (rule.pattern.test(generatorValue)) {
        signals.push({
          canonical: rule.canonical,
          category: rule.category,
          confidence: 0.95,
          sources: ['meta_generator'],
          jobMentionCount: 0,
          jobMentionFrequency: 0,
        });
      }
    }
  }

  // Deduplicate by canonical (keep highest confidence)
  const deduped = new Map();
  for (const sig of signals) {
    const existing = deduped.get(sig.canonical);
    if (!existing || sig.confidence > existing.confidence) {
      deduped.set(sig.canonical, sig);
    }
  }

  const techStack = Array.from(deduped.values());

  logger.info('Header scraper complete', {
    domain,
    techCount: techStack.length,
    ms: Date.now() - startTime,
  });

  return {
    companyName: companyName || domain,
    domain,
    source: 'html_headers',
    scrapedAt: new Date().toISOString(),
    jobCount: 0,
    techStack,
    // Return in the same shape as job scrapers
    jobs: [],
  };
}

// ── CLI runner ──────────────────────────────────────────────────────────────
if (process.argv[1].endsWith('headers.js')) {
  const testDomains = [
    { domain: 'stripe.com',    companyName: 'Stripe' },
    { domain: 'vercel.com',    companyName: 'Vercel' },
    { domain: 'shopify.com',   companyName: 'Shopify' },
    { domain: 'hashicorp.com', companyName: 'HashiCorp' },
    { domain: 'datadog.com',   companyName: 'Datadog' },
  ];

  for (const company of testDomains) {
    const result = await scrapeHeadersForDomain(company);
    if (result) {
      console.log(`\n${company.domain}:`);
      for (const t of result.techStack) {
        console.log(`  ${t.canonical} (${t.category}) — ${t.confidence} confidence via ${t.sources.join(', ')}`);
      }
    } else {
      console.log(`\n${company.domain}: unreachable`);
    }
  }
}
