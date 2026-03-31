/**
 * Memory recall composer.
 *
 * Collects RecallCandidates from zero or more providers, deduplicates by
 * canonical key (favoring stable lane over recent), packs under budget, and
 * renders a single injection string for prependContext.
 */

import { estimateTokens, bucketPriority, lanePriority } from "./candidates.js";

/** Default budget constants — aligned with spec §14.6 combined recall budget. */
const DEFAULT_SOFT_BUDGET_TOKENS = 950;
const DEFAULT_HARD_BUDGET_TOKENS = 1200;

/**
 * Deduplicate candidates by canonicalKey.
 * When duplicates exist, favor stable lane over recent (tie-break).
 * Among same-lane duplicates, favor higher score.
 *
 * @param {import("./candidates.js").RecallCandidate[]} candidates
 * @returns {import("./candidates.js").RecallCandidate[]}
 */
export function dedupeCandidates(candidates) {
  const seen = new Map();

  for (const candidate of candidates) {
    const key = candidate.canonicalKey;
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, candidate);
      continue;
    }

    // Tie-break: prefer stable lane over recent
    const candidateLanePri = lanePriority(candidate.lane);
    const existingLanePri = lanePriority(existing.lane);

    if (candidateLanePri < existingLanePri) {
      seen.set(key, candidate);
      continue;
    }
    if (candidateLanePri > existingLanePri) {
      continue;
    }

    // Same lane: prefer higher score
    if (candidate.score > existing.score) {
      seen.set(key, candidate);
    }
  }

  return Array.from(seen.values());
}

/**
 * Sort candidates for packing.
 *
 * Priority order (spec §14.6):
 *   1. bucket priority (lower = higher priority)
 *   2. lane priority (stable before recent)
 *   3. score descending
 *
 * @param {import("./candidates.js").RecallCandidate[]} candidates
 * @returns {import("./candidates.js").RecallCandidate[]}
 */
export function sortCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    // 1. Bucket priority
    const bucketDiff = bucketPriority(a.bucket) - bucketPriority(b.bucket);
    if (bucketDiff !== 0) return bucketDiff;

    // 2. Lane priority (stable before recent)
    const laneDiff = lanePriority(a.lane) - lanePriority(b.lane);
    if (laneDiff !== 0) return laneDiff;

    // 3. Score descending
    return b.score - a.score;
  });
}

/**
 * Pack candidates under soft/hard token budgets.
 *
 * Strategy:
 * - Fill up to softBudget greedily (by priority order).
 * - Allow overflow up to hardBudget only if the next candidate fits entirely.
 * - Stop at hardBudget.
 *
 * @param {import("./candidates.js").RecallCandidate[]} sortedCandidates
 * @param {Object} [budgets]
 * @param {number} [budgets.softBudgetTokens]
 * @param {number} [budgets.hardBudgetTokens]
 * @returns {{ packed: import("./candidates.js").RecallCandidate[], totalTokens: number, dropped: number }}
 */
export function packCandidates(sortedCandidates, budgets = {}) {
  const softBudget = budgets.softBudgetTokens ?? DEFAULT_SOFT_BUDGET_TOKENS;
  const hardBudget = budgets.hardBudgetTokens ?? DEFAULT_HARD_BUDGET_TOKENS;

  const packed = [];
  let totalTokens = 0;
  let dropped = 0;

  for (const candidate of sortedCandidates) {
    const tokens = candidate.tokenEstimate || estimateTokens(candidate.text);

    if (totalTokens + tokens <= softBudget) {
      packed.push(candidate);
      totalTokens += tokens;
      continue;
    }

    // Past soft budget: only allow if fits within hard budget
    if (totalTokens + tokens <= hardBudget) {
      packed.push(candidate);
      totalTokens += tokens;
      continue;
    }

    dropped += 1;
  }

  return { packed, totalTokens, dropped };
}

/**
 * Render packed candidates into a single prompt string.
 *
 * Groups by lane/source:
 *   - stable memory candidates -> <cognee_memory>
 *   - stable library candidates -> <cognee_library>
 *   - recent lane -> <vestige_recent>
 *
 * Stable candidates are split using candidate.meta.dataset when available.
 * Unknown/legacy stable candidates fall back to the memory lane.
 *
 * @param {import("./candidates.js").RecallCandidate[]} packed
 * @returns {string}
 */
export function renderRecallPacket(packed) {
  if (packed.length === 0) return "";

  const stableMemoryItems = packed.filter(
    (c) => c.lane === "stable" && (c.meta?.dataset === "memory" || c.meta?.dataset == null),
  );
  const stableLibraryItems = packed.filter(
    (c) => c.lane === "stable" && c.meta?.dataset === "library",
  );
  const recentItems = packed.filter((c) => c.lane === "recent");

  const sections = [];

  if (stableMemoryItems.length > 0) {
    const body = stableMemoryItems.map((c) => c.text).join("\n");
    sections.push(`<cognee_memory>\n${body}\n</cognee_memory>`);
  }

  if (stableLibraryItems.length > 0) {
    const body = stableLibraryItems.map((c) => c.text).join("\n");
    sections.push(`<cognee_library>\n${body}\n</cognee_library>`);
  }

  if (recentItems.length > 0) {
    const body = recentItems.map((c) => c.text).join("\n");
    sections.push(`<vestige_recent>\n${body}\n</vestige_recent>`);
  }

  return sections.join("\n\n");
}

/**
 * Full composition pipeline: dedupe -> sort -> pack -> render.
 *
 * @param {import("./candidates.js").RecallCandidate[]} candidates
 * @param {Object} [opts]
 * @param {number} [opts.softBudgetTokens]
 * @param {number} [opts.hardBudgetTokens]
 * @returns {{ packet: string, totalTokens: number, candidateCount: number, dropped: number }}
 */
export function composeRecallPacket(candidates, opts = {}) {
  if (!candidates || candidates.length === 0) {
    return { packet: "", totalTokens: 0, candidateCount: 0, dropped: 0 };
  }

  const deduped = dedupeCandidates(candidates);
  const sorted = sortCandidates(deduped);
  const { packed, totalTokens, dropped } = packCandidates(sorted, opts);
  const packet = renderRecallPacket(packed);

  return { packet, totalTokens, candidateCount: packed.length, dropped };
}
