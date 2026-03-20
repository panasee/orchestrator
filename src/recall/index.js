/**
 * Unified memory recall module — public API.
 *
 * Orchestrates the full recall pipeline:
 *   build query -> collect from providers -> compose packet
 *
 * When no real providers are registered, the pipeline runs with zero
 * candidates and produces an empty packet (no-op).
 */

export { makeCandidate, createNoopProvider, estimateTokens } from "./candidates.js";
export { buildRecallQuery, buildTailSummary } from "./query-builder.js";
export {
  composeRecallPacket,
  dedupeCandidates,
  sortCandidates,
  packCandidates,
  renderRecallPacket,
} from "./composer.js";

import { buildRecallQuery } from "./query-builder.js";
import { composeRecallPacket } from "./composer.js";

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
