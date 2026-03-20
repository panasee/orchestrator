/**
 * RecallCandidate model and provider abstraction for unified memory recall.
 *
 * Providers (vestige-bridge, memory-cognee-revised, etc.) return structured
 * RecallCandidate objects. The orchestrator composer collects, dedupes, packs,
 * and renders them into a single prompt injection.
 */

/** @typedef {"stable" | "recent"} RecallLane */

/**
 * Known bucket categories ordered by packing priority (lower index = higher priority).
 * Unknown buckets sort after all known ones.
 */
export const BUCKET_PRIORITY_ORDER = [
  "active_project_stable",
  "global_constraints",
  "global_preferences",
  "personal_stable",
  "other_stable",
  "library_reference",
  "recent_project_momentum",
  "recent_constraint",
  "recent_preference",
  "recent_life",
  "recent_other",
];

/** Pre-computed priority lookup. */
const BUCKET_PRIORITY_MAP = new Map(BUCKET_PRIORITY_ORDER.map((b, i) => [b, i]));
const UNKNOWN_BUCKET_PRIORITY = BUCKET_PRIORITY_ORDER.length;

/**
 * Get the numeric packing priority for a bucket (lower = higher priority).
 * @param {string} bucket
 * @returns {number}
 */
export function bucketPriority(bucket) {
  return BUCKET_PRIORITY_MAP.get(bucket) ?? UNKNOWN_BUCKET_PRIORITY;
}

/** @typedef {"stable" | "recent"} LaneValue */
const LANE_PRIORITY = /** @type {const} */ ({ stable: 0, recent: 1 });

/**
 * Get the numeric lane priority (lower = higher priority).
 * @param {RecallLane} lane
 * @returns {number}
 */
export function lanePriority(lane) {
  return LANE_PRIORITY[lane] ?? 1;
}

/**
 * @typedef {Object} RecallCandidate
 * @property {string}       canonicalKey  - Dedupe key (provider:type:id or similar).
 * @property {RecallLane}   lane          - "stable" (durable/cognee) or "recent" (vestige).
 * @property {string}       bucket        - Richer category for packing priority (e.g. "active_project_stable").
 * @property {number}       score         - Provider-assigned relevance score, 0-1.
 * @property {number}       tokenEstimate - Rough token count for budget math.
 * @property {string}       text          - Pre-rendered content string for final output.
 * @property {string}       provider      - Provider id that produced this candidate.
 * @property {Record<string, unknown>} [meta] - Opaque provider metadata.
 */

/** Buckets that belong to the stable lane (for inference when lane is not explicit). */
const STABLE_BUCKETS = new Set([
  "active_project_stable",
  "global_constraints",
  "global_preferences",
  "personal_stable",
  "other_stable",
  "library_reference",
]);

/**
 * Infer lane from a bucket string when lane is not explicitly provided.
 * Known stable buckets or buckets ending in _stable -> "stable".
 * Everything else -> "recent".
 * @param {string} bucket
 * @returns {RecallLane}
 */
function inferLane(bucket) {
  if (typeof bucket !== "string") return "recent";
  if (bucket === "stable") return "stable";
  if (bucket === "recent") return "recent";
  if (STABLE_BUCKETS.has(bucket) || bucket.endsWith("_stable")) return "stable";
  return "recent";
}

/**
 * Normalize a bucket value.  Accepts the legacy "stable"/"recent" shorthand
 * (which was the old bucket-as-lane pattern) and maps them to default rich
 * bucket names so downstream packing stays consistent.
 * @param {string} bucket
 * @param {RecallLane} lane
 * @returns {string}
 */
function normalizeBucket(bucket, lane) {
  if (bucket === "stable") return "other_stable";
  if (bucket === "recent") return "recent_other";
  return typeof bucket === "string" && bucket.length > 0 ? bucket : (lane === "stable" ? "other_stable" : "recent_other");
}

/**
 * Create a well-formed RecallCandidate, filling defaults for optional fields.
 *
 * Backward-compatible: if only `bucket` is provided with a legacy value
 * ("stable"/"recent"), lane is inferred and bucket is normalized to a
 * richer category name.
 */
export function makeCandidate({
  canonicalKey,
  lane,
  bucket,
  score,
  tokenEstimate,
  text,
  provider,
  isStable, // deprecated compat — ignored if lane is set
  meta,
}) {
  // Resolve lane: explicit lane > infer from bucket > fallback "recent"
  const resolvedLane = (lane === "stable" || lane === "recent")
    ? lane
    : (typeof bucket === "string" ? inferLane(bucket) : (isStable ? "stable" : "recent"));

  const resolvedBucket = normalizeBucket(bucket, resolvedLane);

  return {
    canonicalKey: String(canonicalKey),
    lane: resolvedLane,
    bucket: resolvedBucket,
    score: typeof score === "number" && Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0,
    tokenEstimate:
      typeof tokenEstimate === "number" && Number.isFinite(tokenEstimate)
        ? Math.max(0, Math.trunc(tokenEstimate))
        : estimateTokens(text),
    text: String(text ?? ""),
    provider: String(provider ?? "unknown"),
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
 * @property {RecallLane} lane - Default lane for this provider's candidates.
 * @property {(query: RecallQuery, opts?: Record<string, unknown>) => Promise<RecallCandidate[]>} recall
 */

/**
 * No-op provider that always returns an empty candidate list.
 * Used as the default when no real providers are wired.
 */
export function createNoopProvider(id = "noop", lane = "recent") {
  return {
    id,
    lane,
    async recall(_query, _opts) {
      return [];
    },
  };
}
