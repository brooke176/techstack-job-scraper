import { ALIAS_MAP, CANONICAL_SET, TECH_TAXONOMY } from './taxonomy.js';

/**
 * Signal confidence weights by source type.
 * HTML headers = highest (they're directly from the running app)
 * Job listings = medium (they reflect what the team uses, but include aspirational tech)
 * Profile pages = lower (curated marketing copy, may be stale)
 */
const CONFIDENCE_BY_SOURCE = {
  html_headers: 0.95,
  job_listing: 0.70,
  github_org: 0.85,
  g2_profile: 0.60,
  linkedin: 0.55,
};

/**
 * Boost confidence when multiple independent sources agree.
 */
const MULTI_SOURCE_BOOST = 0.05; // per additional confirming source beyond the first

/**
 * Extract tech mentions from a block of text using the taxonomy alias map.
 * Uses word-boundary matching to avoid false positives (e.g. "Go" in "Google").
 *
 * @param {string} text
 * @returns {Array<{canonical: string, category: string, rawMention: string}>}
 */
export function extractTechMentions(text) {
  if (!text || typeof text !== 'string') return [];

  const normalizedText = text.toLowerCase();
  const found = new Map(); // canonical → best raw mention

  for (const [alias, techInfo] of ALIAS_MAP) {
    // Use word boundary matching. Escape special regex chars in alias.
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Allow aliases to be preceded/followed by whitespace, punctuation, or string boundaries
    const pattern = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i');

    if (pattern.test(normalizedText)) {
      // Keep the longer alias if we already have a match for this canonical
      if (!found.has(techInfo.canonical) || alias.length > found.get(techInfo.canonical).rawMention.length) {
        found.set(techInfo.canonical, { ...techInfo, rawMention: alias });
      }
    }
  }

  return Array.from(found.values());
}

/**
 * Normalize and score a set of tech signals from one or more sources.
 *
 * @param {Array<{source: string, techs: Array<{canonical, category, rawMention}>}>} signalGroups
 * @returns {Array<{canonical, category, confidence, sources, rawMentions}>}
 */
export function normalizeTechSignals(signalGroups) {
  // Aggregate by canonical name
  const aggregated = new Map();

  for (const { source, techs } of signalGroups) {
    const baseConfidence = CONFIDENCE_BY_SOURCE[source] ?? 0.5;

    for (const tech of techs) {
      if (!aggregated.has(tech.canonical)) {
        aggregated.set(tech.canonical, {
          canonical: tech.canonical,
          category: tech.category,
          confidence: baseConfidence,
          sources: [source],
          rawMentions: [tech.rawMention],
        });
      } else {
        const existing = aggregated.get(tech.canonical);
        // Add source if not already present
        if (!existing.sources.includes(source)) {
          existing.sources.push(source);
          existing.rawMentions.push(tech.rawMention);
          // Boost confidence for corroboration across sources
          existing.confidence = Math.min(
            0.99,
            existing.confidence + MULTI_SOURCE_BOOST
          );
        }
      }
    }
  }

  return Array.from(aggregated.values())
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Parse a full company's job listings and produce a normalized tech profile.
 *
 * @param {Array<{title: string, description: string, source: string}>} jobListings
 * @returns {object} normalized tech profile
 */
export function buildTechProfileFromJobs(jobListings) {
  const signalGroups = jobListings.map(job => ({
    source: 'job_listing',
    techs: extractTechMentions(`${job.title} ${job.description}`),
  }));

  const normalized = normalizeTechSignals(signalGroups);

  // Count how many job listings mentioned each tech (frequency signal)
  const mentionCounts = new Map();
  for (const job of jobListings) {
    const techs = extractTechMentions(`${job.title} ${job.description}`);
    for (const tech of techs) {
      mentionCounts.set(tech.canonical, (mentionCounts.get(tech.canonical) || 0) + 1);
    }
  }

  // Attach frequency data
  return normalized.map(tech => ({
    ...tech,
    jobMentionCount: mentionCounts.get(tech.canonical) || 0,
    jobMentionFrequency: jobListings.length > 0
      ? Math.round((mentionCounts.get(tech.canonical) || 0) / jobListings.length * 100) / 100
      : 0,
  }));
}

/**
 * Group tech results by category for a clean summary view.
 */
export function groupByCategory(techProfile) {
  const grouped = {};
  for (const tech of techProfile) {
    if (!grouped[tech.category]) grouped[tech.category] = [];
    grouped[tech.category].push(tech);
  }
  return grouped;
}
