# TechStack Job Scraper

B2B data product — scrapes job listings from Greenhouse and Lever ATS APIs to build company tech stack profiles.

## Architecture

```
Job boards (Greenhouse API, Lever API, Indeed HTML)
  → HTTP client (retry, proxy, rate limiting)
  → Raw job data
  → Tech extractor (regex + taxonomy)
  → Normalizer (canonical names, confidence scoring)
  → BullMQ queue
  → Postgres storage
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your database URL, Redis connection, and proxy settings
```

### 3. Set up Postgres

```bash
psql $DATABASE_URL -f src/db/schema.sql
```

### 4. Start Redis (required for queue mode)

```bash
docker run -d -p 6379:6379 redis:alpine
```

## Usage

### Run scrapers directly (no Redis needed — good for dev)

```bash
# Scrape all configured companies
node src/index.js

# Greenhouse only
node src/index.js --source=greenhouse

# Lever only
node src/index.js --source=lever

# Single company by domain
node src/index.js --domain=stripe.com
```

### Run via queue (production mode)

```bash
# Start workers
node src/queue/worker.js

# Schedule a full scrape run
node -e "import('./src/queue/queues.js').then(q => q.scheduleFullScrapeRun())"

# Set up recurring daily scrapes
node -e "import('./src/queue/queues.js').then(q => q.scheduleRecurringJobs())"
```

### Run tests

```bash
npm test
```

## Adding companies

### Greenhouse
Add to `GREENHOUSE_COMPANIES` in `src/scrapers/greenhouse.js`:
```js
{ companyName: 'Acme Corp', domain: 'acme.com', token: 'acme' }
```

To find a company's token, visit their careers page and look for:
`greenhouse.io/embed/job_board?for=<TOKEN>` in the page HTML.

### Lever
Add to `LEVER_COMPANIES` in `src/scrapers/lever.js`:
```js
{ companyName: 'Acme Corp', domain: 'acme.com', slug: 'acme' }
```

Token discovery helpers:
```js
import { discoverGreenhouseToken } from './src/scrapers/greenhouse.js';
import { discoverLeverSlug } from './src/scrapers/lever.js';

const token = await discoverGreenhouseToken('https://acme.com/careers');
```

## Output format

Each scrape produces a JSON file in `./data/` with this structure:

```json
{
  "runAt": "2024-01-15T02:00:00Z",
  "totalCompanies": 29,
  "totalJobs": 1847,
  "results": [
    {
      "companyName": "Stripe",
      "domain": "stripe.com",
      "source": "greenhouse",
      "jobCount": 142,
      "techCount": 28,
      "topTech": [
        { "name": "Ruby on Rails", "category": "backend", "confidence": 0.7, "jobMentions": 89 },
        { "name": "Go", "category": "language", "confidence": 0.7, "jobMentions": 67 },
        { "name": "Java", "category": "language", "confidence": 0.7, "jobMentions": 45 }
      ]
    }
  ]
}
```

## Confidence scores

| Source | Base confidence | Notes |
|--------|----------------|-------|
| HTML headers | 0.95 | Directly from running app |
| GitHub org | 0.85 | Repo language data |
| Job listing | 0.70 | Reflects current use, some aspirational |
| G2 profile | 0.60 | Marketing copy, may be stale |
| LinkedIn | 0.55 | Self-reported |

Multiple sources confirming the same tech boost confidence by +0.05 per source.

## Expanding the system

**Add HTML header scraping** → creates a `html-headers.js` scraper in `src/scrapers/`

**Add GitHub org scraping** → queries GitHub API for org repos, extracts languages

**Add the API layer** → see architecture doc for Fastify + Redis cache + auth setup

**Add Postgres writes** → uncomment the `db.query` block in `src/queue/worker.js` and wire up `pg` connection

## Tech taxonomy

Tech names are normalized via `src/enrichment/taxonomy.js`. To add a new technology:

```js
{ canonical: 'Bun', category: 'language', aliases: ['bun', 'bun.js', 'bunjs'] }
```

Aliases are matched case-insensitively with word boundary matching to avoid false positives.

## Production checklist

- [ ] Set up rotating proxies (Bright Data / Oxylabs) for Indeed scraping
- [ ] Configure Postgres with connection pooling (pgBouncer)
- [ ] Set up Redis with persistence (RDB + AOF)
- [ ] Add Sentry for error tracking
- [ ] Set up Grafana dashboard to monitor scrape success rates
- [ ] Add S3 bucket for raw HTML archiving
- [ ] Set up rate limit alerts when scrapers get blocked
