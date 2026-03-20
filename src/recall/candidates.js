/**
 * RecallCandidate model and provider abstraction for unified memory recall.
 *
 * Providers (vestige-bridge, memory-cognee-revised, etc.) return structured
 * RecallCandidate objects. The orchestrator composer collects, dedupes, packs,
 * and renders them into a single prompt injection.
 */

/** @typedef {"stable" | "recent"} RecallBucket */

/**
 * @typedef {Object} RecallCandidate
 * @property {string}        canonicalKey  - Dedupe key (provider:type:id or similar).
 * @property {RecallBucket}  bucket        - "stable" (durable/cognee) or "recent" (vestige).
 * @property {number}        score         - Provider-assigned relevance score, 0-1.
 * @property {number}        tokenEstimate - Rough token count for budget math.
 * @property {string}        text          - Pre-rendered content string for final output.
 * @property {string}        provider      - Provider id that produced this candidate.
 * @property {boolean}       [isStable]    - True if backed by durable materialized memory.
 * @property {Record<string, unknown>} [meta] - Opaque provider metadata.
 */

/**
 * Create a well-formed RecallCandidate, filling defaults for optional fields.
 */
export function makeCandidate({
  canonicalKey,
  bucket,
  score,
  tokenEstimate,
  text,
  provider,
  isStable,
  meta,
}) {
  return {
    canonicalKey: String(canonicalKey),
    bucket: bucket === "stable" ? "stable" : "recent",
    score: typeof score === "number" && Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
    tokenEstimate:
      typeof tokenEstimate === "number" && Number.isFinite(tokenEstimate)
        ? Math.max(0, Math.trunc(tokenEstimate))
        : estimateTokens(text),
    text: String(text ?? ""),
    provider: String(provider ?? "unknown"),
    isStable: Boolean(isStable ?? (bucket === "stable")),
    meta: meta ?? {},
  };
}

/**
 * Cheap token estimator (~4 chars per token).
 */
export function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * @typedef {Object} RecallQuery
 * @property {string}   queryText       - Composed query string for providers.
 * @property {string}   latestUserTurn  - Raw latest user turn text.
 * @property {string}   [tailSummary]   - Lightweight recent conversation summary.
 * @property {string}   [routeHint]     - Current route classification hint.
 * @property {string}   [projectHint]   - Current project/workspace hint.
 */

/**
 * @typedef {Object} RecallProviderConfig
 * @property {string}  id       - Unique provider identifier.
 * @property {boolean} enabled  - Whether this provider is active.
 */

/**
 * Abstract recall provider interface.
 *
 * Concrete providers (vestige-bridge, memory-cognee-revised) will implement
 * this interface. Each returns an array of RecallCandidate objects given a
 * RecallQuery.
 *
 * @typedef {Object} RecallProvider
 * @property {string} id - Provider identifier (e.g. "vestige", "cognee").
 * @property {RecallBucket} bucket - Default bucket for this provider's candidates.
 * @property {(query: RecallQuery, opts?: Record<string, unknown>) => Promise<RecallCandidate[]>} recall
 */

/**
 * No-op provider that always returns an empty candidate list.
 * Used as the default when no real providers are wired.
 */
export function createNoopProvider(id = "noop", bucket = "recent") {
  return {
    id,
    bucket,
    async recall(_query, _opts) {
      return [];
    },
  };
}
