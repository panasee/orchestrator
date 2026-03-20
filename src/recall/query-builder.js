/**
 * Unified recall query builder.
 *
 * Constructs a single RecallQuery from the current turn context so that all
 * providers share the same query basis -- avoiding redundant query construction
 * and duplicate retrieval.
 */

const TAIL_MAX_CHARS = 600;
const TAIL_MAX_MESSAGES = 6;

/**
 * Build a lightweight tail summary from recent messages.
 * Returns a compact string, not the raw transcript.
 *
 * @param {Array<{role: string, content?: string}>} messages
 * @returns {string}
 */
export function buildTailSummary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }

  const tail = messages.slice(-TAIL_MAX_MESSAGES);
  const lines = [];
  let chars = 0;

  for (const msg of tail) {
    if (!msg || typeof msg !== "object") continue;
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const text = extractText(msg);
    if (!text) continue;

    const truncated = text.length > 150 ? text.slice(0, 147) + "..." : text;
    const line = `${role}: ${truncated}`;
    if (chars + line.length > TAIL_MAX_CHARS) break;
    lines.push(line);
    chars += line.length;
  }

  return lines.join("\n");
}

/**
 * Extract plain text from a message object.
 */
function extractText(msg) {
  if (typeof msg.content === "string") return msg.content.trim();
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * Build a unified RecallQuery from the current turn context.
 *
 * @param {Object} params
 * @param {string} params.latestUserTurn - Latest user message text.
 * @param {Array}  [params.messages]     - Full message array for tail summary.
 * @param {string} [params.routeHint]    - Current route classification (e.g. "code_mod").
 * @param {string} [params.projectHint]  - Workspace or project identifier.
 * @returns {import("./candidates.js").RecallQuery}
 */
export function buildRecallQuery({ latestUserTurn, messages, routeHint, projectHint }) {
  const userTurn = typeof latestUserTurn === "string" ? latestUserTurn.trim() : "";
  const tailSummary = buildTailSummary(messages ?? []);

  // Compose a combined query string that providers can use for retrieval.
  // Prioritizes the latest user turn, enriched with tail context and hints.
  const parts = [];
  if (userTurn) parts.push(userTurn);
  if (tailSummary) parts.push(`[context: ${tailSummary.slice(0, 200)}]`);
  if (routeHint) parts.push(`[route: ${routeHint}]`);
  if (projectHint) parts.push(`[project: ${projectHint}]`);

  return {
    queryText: parts.join(" "),
    latestUserTurn: userTurn,
    tailSummary: tailSummary || undefined,
    routeHint: routeHint || undefined,
    projectHint: projectHint || undefined,
  };
}
