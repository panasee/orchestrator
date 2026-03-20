/**
 * Memory recall composer.
 *
 * Collects RecallCandidates from zero or more providers, deduplicates by
 * canonical key (favoring stable over recent), packs under budget, and
 * renders a single injection string for prependContext.
 */

import { estimateTokens } from "./candidates.js";

/** Default budget constants */
const DEFAULT_SOFT_BUDGET_TOKENS = 400;
const DEFAULT_HARD_BUDGET_TOKENS = 600;

/** Bucket priority: stable items are packed first. */
const BUCKET_PRIORITY = /** @type {const} */ ({ stable: 0, recent: 1 });

/**
 * Deduplicate candidates by canonicalKey.
 * When duplicates exist, favor stable over recent (tie-break).
 * Among same-bucket duplicates, favor higher score.
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

    // Tie-break: prefer stable over recent
    if (candidate.isStable && !existing.isStable) {
      seen.set(key, candidate);
      continue;
    }
    if (!candidate.isStable && existing.isStable) {
      continue;
    }

    // Same stability: prefer higher score
    if (candidate.score > existing.score) {
      seen.set(key, candidate);
    }
  }

  return Array.from(seen.values());
}

/**
 * Sort candidates by bucket priority (stable first), then by score descending.
 *
 * @param {import("./candidates.js").RecallCandidate[]} candidates
 * @returns {import("./candidates.js").RecallCandidate[]}
 */
export function sortCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const bucketDiff = (BUCKET_PRIORITY[a.bucket] ?? 1) - (BUCKET_PRIORITY[b.bucket] ?? 1);
    if (bucketDiff !== 0) return bucketDiff;
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
 * Stable and recent candidates are rendered in separate tagged blocks
 * so the model can distinguish provenance.
 *
 * @param {import("./candidates.js").RecallCandidate[]} packed
 * @returns {string}
 */
export function renderRecallPacket(packed) {
  if (packed.length === 0) return "";

  const stableItems = packed.filter((c) => c.bucket === "stable");
  const recentItems = packed.filter((c) => c.bucket === "recent");

  const sections = [];

  if (stableItems.length > 0) {
    const body = stableItems.map((c) => c.text).join("\n");
    sections.push(`<cognee_recall>\n${body}\n</cognee_recall>`);
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
