import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { listRouteNames, normalizeRouteName } from "./routes.js";

function normalizeRouteList(routeNames, routes, defaultRoute, maxRoutes = 3) {
  const availableRoutes = new Set(listRouteNames(routes));
  const normalized = [];
  const seen = new Set();

  for (const routeName of Array.isArray(routeNames) ? routeNames : []) {
    const next = normalizeRouteName(routeName);
    if (!next || !availableRoutes.has(next) || seen.has(next)) {
      continue;
    }
    seen.add(next);
    normalized.push(next);
  }

  const withoutGeneral = normalized.filter((route) => route !== "general");
  const base = withoutGeneral.length > 0 ? withoutGeneral : normalized;
  const limited = base.slice(0, Math.max(1, maxRoutes));
  if (limited.length > 0) {
    return limited;
  }
  return [defaultRoute];
}

function scoreRuleRoute(inputText, routeConfig) {
  const lower = inputText.toLowerCase();
  const keywords = routeConfig?.keywords ?? [];
  let score = 0;

  for (const keyword of keywords) {
    if (lower.includes(keyword.toLowerCase())) {
      score += keyword.includes(" ") ? 3 : 1;
    }
  }

  return score;
}

export function classifyRoutesByRules(inputText, routes, defaultRoute = "general", maxRoutes = 3) {
  const scored = [];

  for (const [routeName, routeConfig] of Object.entries(routes)) {
    if (routeName === "general") {
      continue;
    }
    const score = scoreRuleRoute(inputText, routeConfig);
    if (score > 0) {
      scored.push({ route: routeName, score });
    }
  }

  scored.sort((left, right) => right.score - left.score);
  const selectedRoutes = normalizeRouteList(
    scored.map((entry) => entry.route),
    routes,
    defaultRoute,
    maxRoutes,
  );

  return {
    routes: selectedRoutes,
    source: "rules",
    reason:
      scored.length > 0
        ? scored.map((entry) => `${entry.route}:${entry.score}`).join(",")
        : "no_strong_keyword_match",
  };
}

function stripCodeFences(text) {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? (match[1] ?? "").trim() : text.trim();
}

function parseProviderAndModel(modelRef) {
  if (typeof modelRef !== "string") {
    return null;
  }
  const trimmed = modelRef.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }
  return {
    provider: trimmed.slice(0, slashIndex),
    model: trimmed.slice(slashIndex + 1),
  };
}

function resolveOpenClawHome() {
  const envHome = process.env.OPENCLAW_HOME;
  if (typeof envHome === "string" && envHome.trim().length > 0) {
    return envHome.trim();
  }
  return path.join(os.homedir(), ".openclaw");
}

async function loadJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveProviderConfig(config, provider) {
  const providerConfig = config?.models?.providers?.[provider];
  if (!providerConfig || typeof providerConfig !== "object" || Array.isArray(providerConfig)) {
    return null;
  }

  const api = typeof providerConfig.api === "string" ? providerConfig.api.trim() : "";
  const baseUrl = typeof providerConfig.baseUrl === "string" ? providerConfig.baseUrl.trim() : "";
  const apiKey =
    typeof providerConfig.apiKey === "string" && providerConfig.apiKey.trim().length > 0
      ? providerConfig.apiKey.trim()
      : null;

  if (!api || !baseUrl) {
    return null;
  }

  return {
    api,
    baseUrl,
    apiKey,
  };
}

function resolveApiKeyFromEnv(provider) {
  const normalized = provider.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const candidates = [
    `${normalized}_API_KEY`,
    `${normalized}_TOKEN`,
  ];

  if (provider === "openai") {
    candidates.unshift("OPENAI_API_KEY");
  }
  if (provider === "bailian") {
    candidates.unshift("DASHSCOPE_API_KEY");
  }

  for (const envVar of candidates) {
    const value = process.env[envVar];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function resolveOpenAICodexProfileToken(profile) {
  if (!profile || typeof profile !== "object") {
    return null;
  }
  if (profile.provider !== "openai-codex") {
    return null;
  }
  if (profile.type === "oauth" && typeof profile.access === "string" && profile.access.trim().length > 0) {
    return {
      token: profile.access.trim(),
      expires: Number.isFinite(profile.expires) ? profile.expires : Number.POSITIVE_INFINITY,
    };
  }
  if (profile.type === "token" && typeof profile.token === "string" && profile.token.trim().length > 0) {
    return {
      token: profile.token.trim(),
      expires: Number.isFinite(profile.expires) ? profile.expires : Number.POSITIVE_INFINITY,
    };
  }
  return null;
}

async function resolveOpenAICodexOAuthToken(agentId) {
  const openclawHome = resolveOpenClawHome();
  const candidates = [
    path.join(openclawHome, "agents", String(agentId || "main"), "agent", "auth-profiles.json"),
    path.join(openclawHome, "agents", "main", "agent", "auth-profiles.json"),
  ];

  for (const filePath of candidates) {
    const store = await loadJsonFile(filePath);
    const profiles = store?.profiles;
    if (!profiles || typeof profiles !== "object") {
      continue;
    }

    const preferredId =
      typeof store?.lastGood?.["openai-codex"] === "string" ? store.lastGood["openai-codex"] : null;
    if (preferredId && profiles[preferredId]) {
      const preferred = resolveOpenAICodexProfileToken(profiles[preferredId]);
      if (preferred) {
        return preferred.token;
      }
    }

    const entries = Object.values(profiles)
      .map((profile) => resolveOpenAICodexProfileToken(profile))
      .filter(Boolean)
      .sort((left, right) => (right.expires ?? 0) - (left.expires ?? 0));
    if (entries.length > 0) {
      return entries[0].token;
    }
  }

  return null;
}

function buildClassifierMessages(params) {
  const routeLines = Object.entries(params.routes).map(
    ([routeName, routeConfig]) => `- ${routeName}: ${routeConfig.description}`,
  );

  return [
    {
      role: "system",
      content: [
        "You are a route classifier.",
        "Return only strict JSON.",
        "Do not explain your answer.",
        `Allowed routes: ${listRouteNames(params.routes).join(", ")}.`,
        `If uncertain, return ${params.defaultRoute}.`,
        `Return 1 to ${params.maxRoutes} routes.`,
        'JSON schema: {"routes":["route_a"],"reason":"short reason"}',
      ].join(" "),
    },
    {
      role: "user",
      content: [
        "Classify the following request into one or more routes.",
        "Available routes:",
        ...routeLines,
        "",
        "USER_REQUEST:",
        params.inputText,
      ].join("\n"),
    },
  ];
}

function extractCompletionText(data) {
  const messageContent = data?.choices?.[0]?.message?.content;
  if (typeof messageContent === "string") {
    return messageContent.trim();
  }
  if (Array.isArray(messageContent)) {
    return messageContent
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

async function runDirectOpenAICompatibleClassification(params) {
  const providerConfig = resolveProviderConfig(params.config, params.provider);
  if (!providerConfig) {
    return null;
  }
  if (providerConfig.api !== "openai-completions") {
    throw new Error(`unsupported classifier provider api: ${providerConfig.api}`);
  }

  const apiKey = providerConfig.apiKey ?? resolveApiKeyFromEnv(params.provider);
  if (!apiKey) {
    throw new Error(`missing direct api key for classifier provider: ${params.provider}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("classifier request timed out")), params.llmTimeoutMs);

  try {
    const response = await fetch(`${providerConfig.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: buildClassifierMessages(params),
        temperature: 0,
        max_tokens: 120,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`classifier http ${response.status}: ${errorText || response.statusText}`);
    }

    const data = await response.json();
    const rawText = stripCodeFences(extractCompletionText(data));
    if (!rawText) {
      return null;
    }

    const parsedJson = JSON.parse(rawText);
    const normalizedRoutes = normalizeRouteList(
      Array.isArray(parsedJson?.routes)
        ? parsedJson.routes
        : typeof parsedJson?.route === "string"
          ? [parsedJson.route]
          : [],
      params.routes,
      params.defaultRoute,
      params.maxRoutes,
    );

    return {
      routes: normalizedRoutes,
      source: "llm_direct",
      reason:
        typeof parsedJson?.reason === "string" && parsedJson.reason.trim().length > 0
          ? parsedJson.reason.trim()
          : "classified_by_llm_direct",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractResponsesText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim().length > 0) {
    return data.output_text.trim();
  }
  for (const output of Array.isArray(data?.output) ? data.output : []) {
    if (output?.type === "message") {
      for (const block of Array.isArray(output.content) ? output.content : []) {
        if (block?.type === "output_text" && typeof block.text === "string" && block.text.trim().length > 0) {
          return block.text.trim();
        }
      }
    }
    if (output?.type === "output_text" && typeof output.text === "string" && output.text.trim().length > 0) {
      return output.text.trim();
    }
  }
  return "";
}

function extractOpenAICodexAccountId(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("invalid token");
    }
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string" || accountId.trim().length === 0) {
      throw new Error("missing account id");
    }
    return accountId.trim();
  } catch {
    throw new Error("missing openai-codex account id");
  }
}

function resolveOpenAICodexBaseUrl(config) {
  const configured = config?.models?.providers?.["openai-codex"]?.baseUrl;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }
  return "https://chatgpt.com/backend-api";
}

function resolveOpenAICodexEndpoint(baseUrl) {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

function buildOpenAICodexHeaders(params) {
  const accountId = extractOpenAICodexAccountId(params.token);
  const platform = os.platform?.() ?? "unknown";
  const release = os.release?.() ?? "unknown";
  const arch = os.arch?.() ?? "unknown";
  const headers = {
    Authorization: `Bearer ${params.token}`,
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: "pi",
    "User-Agent": `pi (${platform} ${release}; ${arch})`,
    accept: "text/event-stream",
    "content-type": "application/json",
  };
  if (typeof params.sessionKey === "string" && params.sessionKey.trim().length > 0) {
    headers.session_id = params.sessionKey.trim();
  }
  return headers;
}

function buildOpenAICodexInputMessage(text) {
  return {
    role: "user",
    content: [
      {
        type: "input_text",
        text,
      },
    ],
  };
}

async function readOpenAICodexSseText(response) {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outputText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let boundaryIndex = buffer.indexOf("\n\n");
    while (boundaryIndex !== -1) {
      const chunk = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);

      const dataLines = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
      if (dataLines.length === 0) {
        boundaryIndex = buffer.indexOf("\n\n");
        continue;
      }

      const data = dataLines.join("\n").trim();
      if (!data || data === "[DONE]") {
        boundaryIndex = buffer.indexOf("\n\n");
        continue;
      }

      let event;
      try {
        event = JSON.parse(data);
      } catch {
        boundaryIndex = buffer.indexOf("\n\n");
        continue;
      }

      if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
        outputText += event.delta;
      } else if (event?.type === "response.failed") {
        const errorMessage =
          typeof event?.response?.error?.message === "string" && event.response.error.message.trim().length > 0
            ? event.response.error.message.trim()
            : "openai-codex response failed";
        throw new Error(errorMessage);
      } else if (event?.type === "error") {
        const errorMessage =
          typeof event?.message === "string" && event.message.trim().length > 0
            ? event.message.trim()
            : "openai-codex stream error";
        throw new Error(errorMessage);
      }

      boundaryIndex = buffer.indexOf("\n\n");
    }
  }

  return outputText.trim();
}

async function runDirectOpenAICodexClassification(params) {
  const token = await resolveOpenAICodexOAuthToken(params.agentId);
  if (!token) {
    throw new Error("missing openai-codex oauth token");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("classifier request timed out")), params.llmTimeoutMs);

  try {
    const messages = buildClassifierMessages(params);
    const endpoint = resolveOpenAICodexEndpoint(resolveOpenAICodexBaseUrl(params.config));
    const response = await fetch(endpoint, {
      method: "POST",
      headers: buildOpenAICodexHeaders({
        token,
        sessionKey: `orchestrator-classifier:${params.agentId ?? "main"}`,
      }),
      body: JSON.stringify({
        model: params.model,
        store: false,
        stream: true,
        instructions: messages[0].content,
        input: [buildOpenAICodexInputMessage(messages[1].content)],
        text: {
          verbosity: "low",
        },
        reasoning: {
          effort: "low",
        },
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: `orchestrator-classifier:${params.agentId ?? "main"}`,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`classifier http ${response.status}: ${errorText || response.statusText}`);
    }

    const rawText = stripCodeFences(await readOpenAICodexSseText(response));
    if (!rawText) {
      return null;
    }

    const parsedJson = JSON.parse(rawText);
    const normalizedRoutes = normalizeRouteList(
      Array.isArray(parsedJson?.routes)
        ? parsedJson.routes
        : typeof parsedJson?.route === "string"
          ? [parsedJson.route]
          : [],
      params.routes,
      params.defaultRoute,
      params.maxRoutes,
    );

    return {
      routes: normalizedRoutes,
      source: "llm_direct",
      reason:
        typeof parsedJson?.reason === "string" && parsedJson.reason.trim().length > 0
          ? parsedJson.reason.trim()
          : "classified_by_llm_direct",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyRouteByLlm(params) {
  const parsed = parseProviderAndModel(params.classifierModel);
  if (!parsed) {
    return null;
  }

  if (parsed.provider === "openai-codex") {
    return runDirectOpenAICodexClassification({
      ...params,
      provider: parsed.provider,
      model: parsed.model,
    });
  }

  return runDirectOpenAICompatibleClassification({
    ...params,
    provider: parsed.provider,
    model: parsed.model,
  });
}

export async function classifyRoutes(params) {
  const ruleResult = classifyRoutesByRules(
    params.inputText,
    params.routes,
    params.defaultRoute,
    params.maxRoutes,
  );

  if (!params.classifierModel) {
    return ruleResult;
  }

  try {
    const llmResult = await classifyRouteByLlm(params);
    if (llmResult) {
      return llmResult;
    }
  } catch (error) {
    params.logger?.warn?.(
      `[orchestrator] classifier_model fallback to rules: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return ruleResult;
}

export async function classifyRoute(params) {
  const result = await classifyRoutes({
    ...params,
    maxRoutes: params?.maxRoutes ?? 1,
  });
  return {
    route: result.routes[0] ?? params.defaultRoute ?? "general",
    source: result.source,
    reason: result.reason,
  };
}
