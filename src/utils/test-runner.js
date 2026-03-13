/**
 * Test runner — validates core logic without network calls.
 * Run with: node src/utils/test-runner.js
 */

import { extractTechMentions, buildTechProfileFromJobs, groupByCategory } from '../enrichment/normalizer.js';
import { ALIAS_MAP, TECH_TAXONOMY } from '../enrichment/taxonomy.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(a, b, message) {
  if (a !== b) throw new Error(message || `Expected ${JSON.stringify(a)} to equal ${JSON.stringify(b)}`);
}

function assertIncludes(arr, item, message) {
  if (!arr.includes(item)) throw new Error(message || `Expected [${arr.join(', ')}] to include "${item}"`);
}

// --- Taxonomy tests ---
console.log('\nTaxonomy');

test('taxonomy has entries', () => {
  assert(TECH_TAXONOMY.length > 50, `Expected >50 entries, got ${TECH_TAXONOMY.length}`);
});

test('alias map populated', () => {
  assert(ALIAS_MAP.size > 100, `Expected >100 aliases, got ${ALIAS_MAP.size}`);
});

test('all aliases are lowercase', () => {
  for (const [alias] of ALIAS_MAP) {
    assert(alias === alias.toLowerCase(), `Alias "${alias}" is not lowercase`);
  }
});

test('no duplicate canonical names', () => {
  const names = TECH_TAXONOMY.map(t => t.canonical);
  const unique = new Set(names);
  assertEqual(names.length, unique.size, `Duplicate canonical: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
});

// --- Extraction tests ---
console.log('\nTech extraction');

test('extracts React from job description', () => {
  const text = 'We are looking for a senior engineer with experience in React and TypeScript.';
  const result = extractTechMentions(text);
  const canonicals = result.map(r => r.canonical);
  assertIncludes(canonicals, 'React', 'Should extract React');
  assertIncludes(canonicals, 'TypeScript', 'Should extract TypeScript');
});

test('handles ReactJS alias', () => {
  const text = 'Must know ReactJS and NodeJS';
  const result = extractTechMentions(text);
  const canonicals = result.map(r => r.canonical);
  assertIncludes(canonicals, 'React');
  assertIncludes(canonicals, 'JavaScript');
});

test('handles react.js alias', () => {
  const techs = extractTechMentions('We use react.js for our frontend');
  assertIncludes(techs.map(t => t.canonical), 'React');
});

test('extracts multiple techs from dense job description', () => {
  const text = `
    Software Engineer - Backend
    We use Python, Django, PostgreSQL, Redis, and Kubernetes.
    Experience with AWS and Docker is a plus.
    You will work on our Kafka-based data pipeline.
  `;
  const result = extractTechMentions(text);
  const canonicals = result.map(r => r.canonical);
  assertIncludes(canonicals, 'Python');
  assertIncludes(canonicals, 'Django');
  assertIncludes(canonicals, 'PostgreSQL');
  assertIncludes(canonicals, 'Redis');
  assertIncludes(canonicals, 'Kubernetes');
  assertIncludes(canonicals, 'AWS');
  assertIncludes(canonicals, 'Docker');
  assertIncludes(canonicals, 'Apache Kafka');
});

test('does not false-positive "Go" inside "Google"', () => {
  const text = 'We use Google Cloud Platform and Datadog for monitoring.';
  const result = extractTechMentions(text);
  const canonicals = result.map(r => r.canonical);
  // "Go" should not appear — it's inside "Google"
  assert(!canonicals.includes('Go'), `False positive: "Go" found in "Google Cloud Platform"`);
  assertIncludes(canonicals, 'GCP');
  assertIncludes(canonicals, 'Datadog');
});

test('returns empty array for empty input', () => {
  const result = extractTechMentions('');
  assertEqual(result.length, 0);
});

test('returns empty array for null input', () => {
  const result = extractTechMentions(null);
  assertEqual(result.length, 0);
});

test('deduplicates same tech mentioned multiple times', () => {
  const text = 'React React React reactjs react.js';
  const result = extractTechMentions(text);
  const reactMentions = result.filter(r => r.canonical === 'React');
  assertEqual(reactMentions.length, 1, 'React should appear only once');
});

// --- Profile building tests ---
console.log('\nTech profile building');

test('builds tech profile from job listings', () => {
  const jobs = [
    { title: 'Senior Frontend Engineer', description: 'React, TypeScript, GraphQL required' },
    { title: 'Backend Engineer', description: 'Python and Django, PostgreSQL, Redis' },
    { title: 'DevOps Engineer', description: 'Kubernetes, Docker, AWS, Terraform' },
    { title: 'Frontend Engineer', description: 'React and TypeScript with Next.js' },
  ];

  const profile = buildTechProfileFromJobs(jobs);
  assert(profile.length > 0, 'Profile should have tech entries');

  const reactEntry = profile.find(t => t.canonical === 'React');
  assert(reactEntry, 'React should be in profile');
  assertEqual(reactEntry.jobMentionCount, 2, 'React mentioned in 2 jobs');
  assertEqual(reactEntry.jobMentionFrequency, 0.5, 'React frequency should be 0.5');
});

test('higher frequency techs have higher jobMentionCount', () => {
  const jobs = [
    { title: 'Engineer 1', description: 'Python and PostgreSQL' },
    { title: 'Engineer 2', description: 'Python and Redis' },
    { title: 'Engineer 3', description: 'Python, PostgreSQL, Redis' },
  ];

  const profile = buildTechProfileFromJobs(jobs);
  const python = profile.find(t => t.canonical === 'Python');
  const postgres = profile.find(t => t.canonical === 'PostgreSQL');
  const redis = profile.find(t => t.canonical === 'Redis');

  assert(python.jobMentionCount === 3, `Python should be in 3 jobs, got ${python.jobMentionCount}`);
  assert(postgres.jobMentionCount === 2, `Postgres should be in 2 jobs, got ${postgres.jobMentionCount}`);
  assert(redis.jobMentionCount === 2, `Redis should be in 2 jobs, got ${redis.jobMentionCount}`);
});

test('groupByCategory produces category buckets', () => {
  const jobs = [
    { title: 'Engineer', description: 'React TypeScript Python PostgreSQL AWS Docker' }
  ];
  const profile = buildTechProfileFromJobs(jobs);
  const grouped = groupByCategory(profile);

  assert(grouped.frontend || grouped.language || grouped.database || grouped.cloud || grouped.infrastructure,
    'Should have at least one category');
});

// --- Summary ---
console.log('\n' + '─'.repeat(40));
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nSome tests failed.');
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
}
