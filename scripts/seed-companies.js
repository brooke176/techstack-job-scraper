/**
 * Seed script — scrapes all known companies and stores results directly to Postgres.
 * Bypasses BullMQ so you can populate the DB in one shot.
 *
 * Usage:
 *   node scripts/seed-companies.js
 *   node scripts/seed-companies.js --source greenhouse   # only greenhouse
 *   node scripts/seed-companies.js --source lever
 *   node scripts/seed-companies.js --source headers
 *   node scripts/seed-companies.js --concurrency 3
 */

import 'dotenv/config';
import pLimit from 'p-limit';
import { GREENHOUSE_COMPANIES, fetchGreenhouseJobs } from '../src/scrapers/greenhouse.js';
import { LEVER_COMPANIES, fetchLeverJobs } from '../src/scrapers/lever.js';
import { scrapeHeadersForDomain } from '../src/scrapers/headers.js';
import { buildTechProfileFromJobs } from '../src/enrichment/normalizer.js';
import { query, closePool } from '../src/db/client.js';
import { logger } from '../src/utils/logger.js';

// ── CLI args ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .reduce((acc, arg, i, arr) => {
      if (arg.startsWith('--')) acc.push([arg.slice(2), arr[i + 1] ?? true]);
      return acc;
    }, [])
);

const ONLY_SOURCE   = args.source || null;       // 'greenhouse' | 'lever' | 'headers'
const CONCURRENCY   = parseInt(args.concurrency || '5');

// ── All known companies ─────────────────────────────────────────────────────
const EXTRA_GREENHOUSE = [
  { companyName: 'Anthropic',       domain: 'anthropic.com',      token: 'anthropic' },
  { companyName: 'OpenAI',          domain: 'openai.com',          token: 'openai' },
  { companyName: 'Databricks',      domain: 'databricks.com',      token: 'databricks' },
  { companyName: 'Snowflake',       domain: 'snowflake.com',       token: 'snowflake' },
  { companyName: 'Confluent',       domain: 'confluent.io',        token: 'confluent' },
  { companyName: 'dbt Labs',        domain: 'getdbt.com',          token: 'dbtlabs' },
  { companyName: 'Fivetran',        domain: 'fivetran.com',        token: 'fivetran' },
  { companyName: 'Monte Carlo',     domain: 'montecarlodata.com',  token: 'montecarlodata' },
  { companyName: 'Hex',             domain: 'hex.tech',            token: 'hex' },
  { companyName: 'Modal',           domain: 'modal.com',           token: 'modal' },
  { companyName: 'Temporal',        domain: 'temporal.io',         token: 'temporal' },
  { companyName: 'Turso',           domain: 'turso.tech',          token: 'turso' },
  { companyName: 'Neon',            domain: 'neon.tech',           token: 'neon' },
  { companyName: 'Render',          domain: 'render.com',          token: 'render' },
  { companyName: 'Railway',         domain: 'railway.app',         token: 'railway' },
  { companyName: 'Fly.io',          domain: 'fly.io',              token: 'fly' },
  { companyName: 'Clerk',           domain: 'clerk.com',           token: 'clerk' },
  { companyName: 'WorkOS',          domain: 'workos.com',          token: 'workos' },
  { companyName: 'Stytch',          domain: 'stytch.com',          token: 'stytch' },
  { companyName: 'Resend',          domain: 'resend.com',          token: 'resend' },
  { companyName: 'Loops',           domain: 'loops.so',            token: 'loops' },
  { companyName: 'Postmark',        domain: 'postmarkapp.com',     token: 'wildbit' },
  { companyName: 'Courier',         domain: 'courier.com',         token: 'trycourier' },
  { companyName: 'Inngest',         domain: 'inngest.com',         token: 'inngest' },
  { companyName: 'Trigger.dev',     domain: 'trigger.dev',         token: 'triggerdotdev' },
  { companyName: 'Grafbase',        domain: 'grafbase.com',        token: 'grafbase' },
  { companyName: 'Wundergraph',     domain: 'wundergraph.com',     token: 'wundergraph' },
  { companyName: 'Hasura',          domain: 'hasura.io',           token: 'hasura' },
  { companyName: 'Nhost',           domain: 'nhost.io',            token: 'nhost' },
  { companyName: 'Appwrite',        domain: 'appwrite.io',         token: 'appwrite' },
  { companyName: 'Convex',          domain: 'convex.dev',          token: 'convexdev' },
  { companyName: 'Xata',            domain: 'xata.io',             token: 'xata' },
  { companyName: 'Cockroach Labs',  domain: 'cockroachlabs.com',   token: 'cockroachlabs' },
  { companyName: 'SingleStore',     domain: 'singlestore.com',     token: 'singlestore' },
  { companyName: 'Timescale',       domain: 'timescale.com',       token: 'timescale' },
  { companyName: 'Yugabyte',        domain: 'yugabyte.com',        token: 'yugabyte' },
  { companyName: 'PingCAP',         domain: 'pingcap.com',         token: 'pingcap' },
  { companyName: 'Crunchy Data',    domain: 'crunchydata.com',     token: 'crunchydata' },
  { companyName: 'Fauna',           domain: 'fauna.com',           token: 'fauna' },
  { companyName: 'Upstash',         domain: 'upstash.com',         token: 'upstash' },
  { companyName: 'Momento',         domain: 'gomomento.com',       token: 'momentohq' },
  { companyName: 'Qdrant',          domain: 'qdrant.tech',         token: 'qdrant' },
  { companyName: 'Weaviate',        domain: 'weaviate.io',         token: 'weaviate' },
  { companyName: 'Pinecone',        domain: 'pinecone.io',         token: 'pinecone' },
  { companyName: 'Chroma',          domain: 'trychroma.com',       token: 'chroma' },
  { companyName: 'Milvus',          domain: 'zilliz.com',          token: 'zilliz' },
  { companyName: 'LangChain',       domain: 'langchain.com',       token: 'langchain' },
  { companyName: 'Weights & Biases',domain: 'wandb.ai',            token: 'wandb' },
  { companyName: 'Hugging Face',    domain: 'huggingface.co',      token: 'huggingface' },
  { companyName: 'Replicate',       domain: 'replicate.com',       token: 'replicate' },
  { companyName: 'Modal Labs',      domain: 'modal.com',           token: 'modal' },
  { companyName: 'Together AI',     domain: 'together.ai',         token: 'togetherai' },
  { companyName: 'Cohere',          domain: 'cohere.com',          token: 'cohere' },
  { companyName: 'Mistral AI',      domain: 'mistral.ai',          token: 'mistralai' },
  { companyName: 'Groq',            domain: 'groq.com',            token: 'groq' },
  { companyName: 'Perplexity',      domain: 'perplexity.ai',       token: 'perplexityai' },
  { companyName: 'Character.AI',    domain: 'character.ai',        token: 'characterai' },
  { companyName: 'Stability AI',    domain: 'stability.ai',        token: 'stabilityai' },
  { companyName: 'Midjourney',      domain: 'midjourney.com',      token: 'midjourney' },
  { companyName: 'Scale AI',        domain: 'scale.com',           token: 'scaleai' },
  { companyName: 'Labelbox',        domain: 'labelbox.com',        token: 'labelbox' },
  { companyName: 'Snorkel AI',      domain: 'snorkel.ai',          token: 'snorkelai' },
  { companyName: 'Vanta',           domain: 'vanta.com',           token: 'vanta' },
  { companyName: 'Drata',           domain: 'drata.com',           token: 'drata' },
  { companyName: 'Tugboat Logic',   domain: 'onspring.com',        token: 'tugboatlogic' },
  { companyName: 'Secureframe',     domain: 'secureframe.com',     token: 'secureframe' },
  { companyName: 'Lacework',        domain: 'lacework.com',        token: 'lacework' },
  { companyName: 'Orca Security',   domain: 'orca.security',       token: 'orcasecurity' },
  { companyName: 'Wiz',             domain: 'wiz.io',              token: 'wizsecurity' },
  { companyName: 'Snyk',            domain: 'snyk.io',             token: 'snyk' },
  { companyName: 'Socket',          domain: 'socket.dev',          token: 'socket' },
  { companyName: 'Semgrep',         domain: 'semgrep.dev',         token: 'semgrep' },
  { companyName: 'Endor Labs',      domain: 'endorlabs.com',       token: 'endorlabs' },
  { companyName: 'Chainguard',      domain: 'chainguard.dev',      token: 'chainguard' },
  { companyName: 'Permit.io',       domain: 'permit.io',           token: 'permitio' },
  { companyName: 'Cerbos',          domain: 'cerbos.dev',          token: 'cerbos' },
  { companyName: 'Styra',           domain: 'styra.com',           token: 'styra' },
  { companyName: 'Teleport',        domain: 'goteleport.com',      token: 'gravitational' },
  { companyName: 'Tailscale',       domain: 'tailscale.com',       token: 'tailscale' },
  { companyName: 'Cloudflare',      domain: 'cloudflare.com',      token: 'cloudflare' },
  { companyName: 'Fastly',          domain: 'fastly.com',          token: 'fastly' },
  { companyName: 'Akamai',          domain: 'akamai.com',          token: 'akamai' },
  { companyName: 'Netlify',         domain: 'netlify.com',         token: 'netlify' },
  { companyName: 'Contentful',      domain: 'contentful.com',      token: 'contentful' },
  { companyName: 'Sanity',          domain: 'sanity.io',           token: 'sanity' },
  { companyName: 'Prismic',         domain: 'prismic.io',          token: 'prismic' },
  { companyName: 'Storyblok',       domain: 'storyblok.com',       token: 'storyblok' },
  { companyName: 'Builder.io',      domain: 'builder.io',          token: 'builderio' },
  { companyName: 'Webflow',         domain: 'webflow.com',         token: 'webflow' },
  { companyName: 'Framer',          domain: 'framer.com',          token: 'framer' },
  { companyName: 'Storybook',       domain: 'chromatic.com',       token: 'chromatic' },
  { companyName: 'Nx',              domain: 'nx.dev',              token: 'nrwl' },
  { companyName: 'Turbo',           domain: 'turbo.build',         token: 'vercel' },
  { companyName: 'Expo',            domain: 'expo.dev',            token: 'expo' },
  { companyName: 'Ionic',           domain: 'ionic.io',            token: 'ionic' },
  { companyName: 'Capacitor',       domain: 'capacitorjs.com',     token: 'ionic' },
  { companyName: 'Tauri',           domain: 'tauri.app',           token: 'tauri' },
  { companyName: 'Electron',        domain: 'electronjs.org',      token: 'electronjs' },
  { companyName: 'Sentry',          domain: 'sentry.io',           token: 'sentry' },
  { companyName: 'Datadog',         domain: 'datadoghq.com',       token: 'datadog' },
  { companyName: 'New Relic',       domain: 'newrelic.com',        token: 'newrelic' },
  { companyName: 'Dynatrace',       domain: 'dynatrace.com',       token: 'dynatrace' },
  { companyName: 'Honeycomb',       domain: 'honeycomb.io',        token: 'honeycomb' },
  { companyName: 'Lightstep',       domain: 'lightstep.com',       token: 'lightstep' },
  { companyName: 'Logz.io',         domain: 'logz.io',             token: 'logzio' },
  { companyName: 'Papertrail',      domain: 'papertrail.com',      token: 'papertrail' },
  { companyName: 'PagerDuty',       domain: 'pagerduty.com',       token: 'pagerduty' },
  { companyName: 'OpsGenie',        domain: 'atlassian.com',       token: 'opsgenie' },
  { companyName: 'Better Uptime',   domain: 'betteruptime.com',    token: 'betteruptime' },
  { companyName: 'Statuspage',      domain: 'atlassian.com',       token: 'statuspage' },
  { companyName: 'PostHog',         domain: 'posthog.com',         token: 'posthog' },
  { companyName: 'Mixpanel',        domain: 'mixpanel.com',        token: 'mixpanel' },
  { companyName: 'Amplitude',       domain: 'amplitude.com',       token: 'amplitude' },
  { companyName: 'Heap',            domain: 'heap.io',             token: 'heap' },
  { companyName: 'FullStory',       domain: 'fullstory.com',       token: 'fullstory' },
  { companyName: 'LogRocket',       domain: 'logrocket.com',       token: 'logrocket' },
  { companyName: 'Hotjar',          domain: 'hotjar.com',          token: 'hotjar' },
  { companyName: 'Pendo',           domain: 'pendo.io',            token: 'pendo' },
  { companyName: 'LaunchDarkly',    domain: 'launchdarkly.com',    token: 'launchdarkly' },
  { companyName: 'Split.io',        domain: 'split.io',            token: 'split' },
  { companyName: 'Flagsmith',       domain: 'flagsmith.com',       token: 'flagsmith' },
  { companyName: 'Unleash',         domain: 'getunleash.io',       token: 'unleash' },
  { companyName: 'Statsig',         domain: 'statsig.com',         token: 'statsig' },
  { companyName: 'Eppo',            domain: 'geteppo.com',         token: 'eppo' },
  { companyName: 'Optimizely',      domain: 'optimizely.com',      token: 'optimizely' },
  { companyName: 'Braze',           domain: 'braze.com',           token: 'braze' },
  { companyName: 'Iterable',        domain: 'iterable.com',        token: 'iterable' },
  { companyName: 'Klaviyo',         domain: 'klaviyo.com',         token: 'klaviyo' },
  { companyName: 'Customer.io',     domain: 'customer.io',         token: 'customerio' },
  { companyName: 'Mailchimp',       domain: 'mailchimp.com',       token: 'mailchimp' },
  { companyName: 'Twilio',          domain: 'twilio.com',          token: 'twilio' },
  { companyName: 'Vonage',          domain: 'vonage.com',          token: 'vonage' },
  { companyName: 'Bandwidth',       domain: 'bandwidth.com',       token: 'bandwidth' },
  { companyName: 'Telnyx',          domain: 'telnyx.com',          token: 'telnyx' },
  { companyName: 'Sinch',           domain: 'sinch.com',           token: 'sinch' },
  { companyName: 'MessageBird',     domain: 'bird.com',            token: 'messagebird' },
  { companyName: 'Nylas',           domain: 'nylas.com',           token: 'nylas' },
  { companyName: 'Pusher',          domain: 'pusher.com',          token: 'pusher' },
  { companyName: 'Ably',            domain: 'ably.com',            token: 'ably' },
  { companyName: 'Liveblocks',      domain: 'liveblocks.io',       token: 'liveblocks' },
  { companyName: 'PartyKit',        domain: 'partykit.io',         token: 'partykit' },
  { companyName: 'Deepgram',        domain: 'deepgram.com',        token: 'deepgram' },
  { companyName: 'AssemblyAI',      domain: 'assemblyai.com',      token: 'assemblyai' },
  { companyName: 'ElevenLabs',      domain: 'elevenlabs.io',       token: 'elevenlabs' },
  { companyName: 'Cartesia',        domain: 'cartesia.ai',         token: 'cartesia' },
  { companyName: 'Browserless',     domain: 'browserless.io',      token: 'browserless' },
  { companyName: 'Apify',           domain: 'apify.com',           token: 'apify' },
  { companyName: 'Bright Data',     domain: 'brightdata.com',      token: 'brightdata' },
  { companyName: 'Oxylabs',         domain: 'oxylabs.io',          token: 'oxylabs' },
  { companyName: 'Smartproxy',      domain: 'smartproxy.com',      token: 'smartproxy' },
  { companyName: 'Zendesk',         domain: 'zendesk.com',         token: 'zendesk' },
  { companyName: 'Intercom',        domain: 'intercom.com',        token: 'intercom' },
  { companyName: 'Freshdesk',       domain: 'freshworks.com',      token: 'freshworks' },
  { companyName: 'HubSpot',         domain: 'hubspot.com',         token: 'hubspot' },
  { companyName: 'Salesforce',      domain: 'salesforce.com',      token: 'salesforce' },
  { companyName: 'Pipedrive',       domain: 'pipedrive.com',       token: 'pipedrive' },
  { companyName: 'Close',           domain: 'close.com',           token: 'close' },
  { companyName: 'Apollo.io',       domain: 'apollo.io',           token: 'apollo' },
  { companyName: 'Outreach',        domain: 'outreach.io',         token: 'outreach' },
  { companyName: 'Salesloft',       domain: 'salesloft.com',       token: 'salesloft' },
  { companyName: 'Gong',            domain: 'gong.io',             token: 'gong' },
  { companyName: 'Chorus',          domain: 'chorus.ai',           token: 'chorus' },
  { companyName: 'Clari',           domain: 'clari.com',           token: 'clari' },
  { companyName: 'Vivun',           domain: 'vivun.com',           token: 'vivun' },
  { companyName: 'Highspot',        domain: 'highspot.com',        token: 'highspot' },
  { companyName: 'Seismic',         domain: 'seismic.com',         token: 'seismic' },
  { companyName: 'Gitlab',          domain: 'gitlab.com',          token: 'gitlab' },
  { companyName: 'GitHub',          domain: 'github.com',          token: 'github' },
  { companyName: 'Bitbucket',       domain: 'atlassian.com',       token: 'atlassian' },
  { companyName: 'CircleCI',        domain: 'circleci.com',        token: 'circleci' },
  { companyName: 'Travis CI',       domain: 'travis-ci.com',       token: 'travisci' },
  { companyName: 'Buildkite',       domain: 'buildkite.com',       token: 'buildkite' },
  { companyName: 'Harness',         domain: 'harness.io',          token: 'harness' },
  { companyName: 'Codefresh',       domain: 'codefresh.io',        token: 'codefresh' },
  { companyName: 'Spacelift',       domain: 'spacelift.io',        token: 'spacelift' },
  { companyName: 'Env0',            domain: 'env0.com',            token: 'env0' },
  { companyName: 'Scalr',           domain: 'scalr.com',           token: 'scalr' },
  { companyName: 'Pulumi',          domain: 'pulumi.com',          token: 'pulumi' },
  { companyName: 'Crossplane',      domain: 'crossplane.io',       token: 'upbound' },
  { companyName: 'Cortex',          domain: 'cortex.io',           token: 'cortexappio' },
  { companyName: 'Port',            domain: 'getport.io',          token: 'getport' },
  { companyName: 'OpsLevel',        domain: 'opslevel.com',        token: 'opslevel' },
  { companyName: 'Backstage',       domain: 'roadie.io',           token: 'roadie' },
  { companyName: 'Cortex',          domain: 'cortex.io',           token: 'getcortexapp' },
  { companyName: 'PagerDuty',       domain: 'pagerduty.com',       token: 'pagerduty' },
];

const EXTRA_LEVER = [
  { companyName: 'Stripe',          domain: 'stripe.com',          slug: 'stripe' },
  { companyName: 'Figma',           domain: 'figma.com',           slug: 'figma' },
  { companyName: 'Notion',          domain: 'notion.so',           slug: 'notion' },
  { companyName: 'Vercel',          domain: 'vercel.com',          slug: 'vercel' },
  { companyName: 'Linear',          domain: 'linear.app',          slug: 'linear' },
  { companyName: 'Loom',            domain: 'loom.com',            slug: 'loom' },
  { companyName: 'Retool',          domain: 'retool.com',          slug: 'retool' },
  { companyName: 'Brex',            domain: 'brex.com',            slug: 'brex' },
  { companyName: 'Mercury',         domain: 'mercury.com',         slug: 'mercury' },
  { companyName: 'Ramp',            domain: 'ramp.com',            slug: 'ramp' },
  { companyName: 'Rippling',        domain: 'rippling.com',        slug: 'rippling' },
  { companyName: 'Gusto',           domain: 'gusto.com',           slug: 'gusto' },
  { companyName: 'Carta',           domain: 'carta.com',           slug: 'carta' },
  { companyName: 'Stripe',          domain: 'stripe.com',          slug: 'stripe' },
  { companyName: 'Coinbase',        domain: 'coinbase.com',        slug: 'coinbase' },
  { companyName: 'Robinhood',       domain: 'robinhood.com',       slug: 'robinhood' },
  { companyName: 'Chime',           domain: 'chime.com',           slug: 'chime' },
  { companyName: 'Nerdwallet',      domain: 'nerdwallet.com',      slug: 'nerdwallet' },
  { companyName: 'Credit Karma',    domain: 'creditkarma.com',     slug: 'creditkarma' },
  { companyName: 'Blend',           domain: 'blend.com',           slug: 'blend' },
  { companyName: 'Better.com',      domain: 'better.com',          slug: 'better' },
  { companyName: 'Hippo',           domain: 'hippo.com',           slug: 'hippo' },
  { companyName: 'Lemonade',        domain: 'lemonade.com',        slug: 'lemonade' },
  { companyName: 'Root Insurance',  domain: 'joinroot.com',        slug: 'root' },
  { companyName: 'Metronome',       domain: 'metronome.com',       slug: 'metronome' },
  { companyName: 'Orb',             domain: 'withorb.com',         slug: 'withorb' },
  { companyName: 'Lago',            domain: 'getlago.com',         slug: 'getlago' },
  { companyName: 'Stigg',           domain: 'stigg.io',            slug: 'stigg' },
  { companyName: 'Payhawk',         domain: 'payhawk.com',         slug: 'payhawk' },
  { companyName: 'Spendesk',        domain: 'spendesk.com',        slug: 'spendesk' },
  { companyName: 'Navan',           domain: 'navan.com',           slug: 'tripactions' },
  { companyName: 'Expensify',       domain: 'expensify.com',       slug: 'expensify' },
  { companyName: 'Deel',            domain: 'deel.com',            slug: 'deel' },
  { companyName: 'Remote',          domain: 'remote.com',          slug: 'remote' },
  { companyName: 'Oyster HR',       domain: 'oysterhr.com',        slug: 'oyster' },
  { companyName: 'Lattice',         domain: 'lattice.com',         slug: 'lattice' },
  { companyName: 'Culture Amp',     domain: 'cultureamp.com',      slug: 'cultureamp' },
  { companyName: 'Leapsome',        domain: 'leapsome.com',        slug: 'leapsome' },
  { companyName: 'Betterworks',     domain: 'betterworks.com',     slug: 'betterworks' },
  { companyName: 'Workday',         domain: 'workday.com',         slug: 'workday' },
  { companyName: 'Greenhouse',      domain: 'greenhouse.io',       slug: 'greenhouse' },
  { companyName: 'Lever',           domain: 'lever.co',            slug: 'lever' },
  { companyName: 'Ashby',           domain: 'ashbyhq.com',         slug: 'ashby' },
  { companyName: 'Gem',             domain: 'gem.com',             slug: 'gem' },
  { companyName: 'Beamery',         domain: 'beamery.com',         slug: 'beamery' },
  { companyName: 'Eightfold AI',    domain: 'eightfold.ai',        slug: 'eightfoldai' },
  { companyName: 'ServiceNow',      domain: 'servicenow.com',      slug: 'servicenow' },
  { companyName: 'Workato',         domain: 'workato.com',         slug: 'workato' },
  { companyName: 'Tray.io',         domain: 'tray.io',             slug: 'tray' },
  { companyName: 'n8n',             domain: 'n8n.io',              slug: 'n8n' },
  { companyName: 'Make',            domain: 'make.com',            slug: 'make' },
  { companyName: 'Pipedream',       domain: 'pipedream.com',       slug: 'pipedream' },
  { companyName: 'Retool',          domain: 'retool.com',          slug: 'retool' },
  { companyName: 'Appsmith',        domain: 'appsmith.com',        slug: 'appsmith' },
  { companyName: 'Budibase',        domain: 'budibase.com',        slug: 'budibase' },
  { companyName: 'Tooljet',         domain: 'tooljet.com',         slug: 'tooljet' },
  { companyName: 'Airplane',        domain: 'airplane.dev',        slug: 'airplane' },
  { companyName: 'Superblocks',     domain: 'superblocks.com',     slug: 'superblocks' },
  { companyName: 'Windmill',        domain: 'windmill.dev',        slug: 'windmill' },
  { companyName: 'Deno',            domain: 'deno.com',            slug: 'deno' },
  { companyName: 'Bun',             domain: 'oven.sh',             slug: 'oven' },
  { companyName: 'Volta',           domain: 'volta.sh',            slug: 'volta' },
  { companyName: 'PNPM',            domain: 'pnpm.io',             slug: 'pnpm' },
];

// Combine and deduplicate by domain
function dedupeByDomain(arr) {
  const seen = new Set();
  return arr.filter(c => {
    if (seen.has(c.domain)) return false;
    seen.add(c.domain);
    return true;
  });
}

const allGreenhouse = dedupeByDomain([...GREENHOUSE_COMPANIES, ...EXTRA_GREENHOUSE]);
const allLever      = dedupeByDomain([...LEVER_COMPANIES,      ...EXTRA_LEVER]);

// All unique domains for headers scraping
const allDomains = dedupeByDomain([
  ...allGreenhouse.map(c => ({ domain: c.domain, companyName: c.companyName })),
  ...allLever.map(c => ({ domain: c.domain, companyName: c.companyName })),
]);

// ── Persist a scrape result to Postgres ─────────────────────────────────────
async function storeResult(result) {
  if (!result) return;
  const { companyName, domain, source, scrapedAt, jobCount, techStack } = result;

  // Build tech profile from raw tech stack (headers scraper) or jobs (job scrapers)
  const techProfile = Array.isArray(result.jobs) && result.jobs.length > 0
    ? buildTechProfileFromJobs(result.jobs)
    : (techStack || []);

  if (!techProfile || techProfile.length === 0) return;

  // Upsert company
  await query(
    `INSERT INTO companies (domain, name)
     VALUES ($1, $2)
     ON CONFLICT (domain) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
    [domain, companyName]
  );

  // Fetch previous tech profile for diff
  const prev = await query(
    `SELECT tech_profile FROM company_tech_profiles
     WHERE domain = $1 AND source = $2 ORDER BY scraped_at DESC LIMIT 1`,
    [domain, source]
  );
  const prevTechs = new Map((prev.rows[0]?.tech_profile || []).map(t => [t.canonical, t]));

  // Upsert tech profile
  await query(
    `INSERT INTO company_tech_profiles
       (domain, source, job_count, tech_count, tech_profile, scraped_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (domain, source) DO UPDATE
       SET job_count    = EXCLUDED.job_count,
           tech_count   = EXCLUDED.tech_count,
           tech_profile = EXCLUDED.tech_profile,
           scraped_at   = EXCLUDED.scraped_at,
           updated_at   = NOW()`,
    [domain, source, jobCount || 0, techProfile.length, JSON.stringify(techProfile), scrapedAt]
  );

  // Change events
  const currentTechs = new Map(techProfile.map(t => [t.canonical, t]));
  for (const [canonical, tech] of currentTechs) {
    if (!prevTechs.has(canonical)) {
      await query(
        `INSERT INTO tech_change_events (domain, event_type, canonical, category, new_confidence)
         VALUES ($1, 'added', $2, $3, $4)`,
        [domain, canonical, tech.category, tech.confidence]
      ).catch(() => {});
    }
  }
  for (const [canonical, tech] of prevTechs) {
    if (!currentTechs.has(canonical)) {
      await query(
        `INSERT INTO tech_change_events (domain, event_type, canonical, category, old_confidence)
         VALUES ($1, 'removed', $2, $3, $4)`,
        [domain, canonical, tech.category, tech.confidence]
      ).catch(() => {});
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function run() {
  const limit = pLimit(CONCURRENCY);

  const stats = { ok: 0, skip: 0, fail: 0 };
  const tick = (status) => {
    stats[status]++;
    const total = stats.ok + stats.skip + stats.fail;
    process.stdout.write(`\r  ${total} processed — ✓ ${stats.ok}  ⊘ ${stats.skip}  ✗ ${stats.fail}`);
  };

  const runTask = (label, fn) => limit(async () => {
    try {
      const result = await fn();
      await storeResult(result);
      tick(result ? 'ok' : 'skip');
    } catch (err) {
      tick('fail');
      logger.debug(`Seed error [${label}]: ${err.message}`);
    }
  });

  const tasks = [];

  if (!ONLY_SOURCE || ONLY_SOURCE === 'greenhouse') {
    console.log(`\nGreenhouse: ${allGreenhouse.length} companies`);
    for (const c of allGreenhouse) {
      tasks.push(runTask(`greenhouse:${c.domain}`, () => fetchGreenhouseJobs(c)));
    }
  }

  if (!ONLY_SOURCE || ONLY_SOURCE === 'lever') {
    console.log(`Lever: ${allLever.length} companies`);
    for (const c of allLever) {
      tasks.push(runTask(`lever:${c.domain}`, () => fetchLeverJobs(c)));
    }
  }

  if (!ONLY_SOURCE || ONLY_SOURCE === 'headers') {
    console.log(`Headers: ${allDomains.length} domains`);
    for (const c of allDomains) {
      tasks.push(runTask(`headers:${c.domain}`, () => scrapeHeadersForDomain(c)));
    }
  }

  console.log(`\nRunning ${tasks.length} tasks (concurrency: ${CONCURRENCY})...\n`);
  await Promise.all(tasks);

  console.log(`\n\nDone. ok=${stats.ok} skipped=${stats.skip} failed=${stats.fail}`);

  // Summary
  const { rows } = await query(
    `SELECT COUNT(*) AS companies,
            SUM(tech_count) AS tech_signals
     FROM company_tech_profiles`
  );
  console.log(`\nDB totals: ${rows[0].companies} profiles, ${rows[0].tech_signals} tech signals`);

  await closePool();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
