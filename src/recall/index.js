/**
 * Unified memory recall module — public API.
 *
 * Orchestrates the full recall pipeline:
 *   build query -> collect from providers -> compose packet
 *
 * When no real providers are registered, the pipeline runs with zero
 * candidates and produces an empty packet (no-op).
 */

export { makeCandidate, createNoopProvider, estimateTokens, bucketPriority, lanePriority, BUCKET_PRIORITY_ORDER } from "./candidates.js";
export { buildRecallQuery, buildTailSummary } from "./query-builder.js";
export {
  composeRecallPacket,
  dedupeCandidates,
  sortCandidates,
  packCandidates,
  renderRecallPacket,
} from "./composer.js";
export {
  registerSharedRecallProvider,
  listSharedRecallProviders,
  clearSharedRecallProviders,
} from "./registry.js";

import { buildRecallQuery } from "./query-builder.js";
import { composeRecallPacket } from "./composer.js";

/**
 * Static system guidance block injected via prependSystemContext.
 * Concise interpretation and conflict rules for the two memory blocks.
 */
export const RECALL_SYSTEM_GUIDANCE = [
  "Two memory blocks may appear in context for this turn:",
  "- <cognee_recall>: durable stable memory from long-term knowledge graphs. Treat as authoritative baseline facts.",
  "- <vestige_recent>: recent cognitive memory (short/mid-term preferences, life-stream, active concerns). Treat as fresher but less verified.",
  "Interpretation rules:",
  "- Both blocks coexist; they are not mutually exclusive.",
  "- If they overlap on the same fact, prefer the <cognee_recall> version unless <vestige_recent> contains a more recent explicit user correction.",
  "- If they conflict, prefer the most recently user-confirmed item.",
  "- Use injected memory only when directly relevant to the current turn.",
].join("\n");

/**
 * Run the full recall pipeline.
 *
 * @param {Object} params
 * @param {import("./candidates.js").RecallProvider[]} params.providers - Registered recall providers.
 * @param {string} params.latestUserTurn - Latest user message text.
 * @param {Array}  [params.messages]     - Message array for tail summary.
 * @param {string} [params.routeHint]    - Current route hint.
 * @param {string} [params.projectHint]  - Current project hint.
 * @param {number} [params.softBudgetTokens] - Soft token budget.
 * @param {number} [params.hardBudgetTokens] - Hard token budget.
 * @param {Object} [params.logger]       - Logger instance.
 * @returns {Promise<{ packet: string, totalTokens: number, candidateCount: number, dropped: number }>}
 */
export async function runRecallPipeline({
  providers,
  latestUserTurn,
  messages,
  routeHint,
  projectHint,
  softBudgetTokens,
  hardBudgetTokens,
  logger,
}) {
  const activeProviders = Array.isArray(providers) ? providers.filter((p) => p && typeof p.recall === "function") : [];

  if (activeProviders.length === 0 || !latestUserTurn) {
    return { packet: "", totalTokens: 0, candidateCount: 0, dropped: 0 };
  }

  // 1. Build unified query once
  const query = buildRecallQuery({ latestUserTurn, messages, routeHint, projectHint });

  // 2. Collect candidates from all providers in parallel (fail-soft per provider)
  const results = await Promise.allSettled(
    activeProviders.map((provider) =>
      provider.recall(query).catch((err) => {
        logger?.warn?.(
          `[orchestrator:recall] provider ${provider.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }),
    ),
  );

  const allCandidates = [];
  for (const result of results) {
    if (result.status === "fulfilled" && Array.isArray(result.value)) {
      allCandidates.push(...result.value);
    }
  }

  // 3. Compose: dedupe -> sort -> pack -> render
  return composeRecallPacket(allCandidates, { softBudgetTokens, hardBudgetTokens });
}
