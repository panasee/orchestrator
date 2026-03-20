import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyRoutes,
} from "./src/classifier.js";
import {
  listRouteDescriptions,
  listRouteNames,
  normalizeRouteName,
  resolveRoutes,
} from "./src/routes.js";
import { runRecallPipeline } from "./src/recall/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolvePromptFiles(rawFiles) {
  const files = [];
  const seen = new Set();

  for (const rawFile of Array.isArray(rawFiles) ? rawFiles : []) {
    if (typeof rawFile !== "string" || rawFile.trim().length === 0) {
      continue;
    }
    const resolved = path.isAbsolute(rawFile) ? rawFile : path.resolve(__dirname, rawFile.trim());
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    files.push(resolved);
  }

  return files;
}

function resolvePluginConfig(rawConfig) {
  const enabledAgents = Array.isArray(rawConfig?.enabledAgents)
    ? rawConfig.enabledAgents.filter((value) => typeof value === "string" && value.trim().length > 0)
    : [];
  const corePromptFiles = resolvePromptFiles(rawConfig?.corePromptFiles);
  const commonPromptFiles = resolvePromptFiles(rawConfig?.commonPromptFiles);
  const classifierModel =
    typeof rawConfig?.classifierModel === "string" && rawConfig.classifierModel.trim().length > 0
      ? rawConfig.classifierModel.trim()
      : undefined;
  const llmTimeoutMs =
    typeof rawConfig?.llmTimeoutMs === "number" && Number.isFinite(rawConfig.llmTimeoutMs)
      ? Math.max(1000, Math.trunc(rawConfig.llmTimeoutMs))
      : 8000;
  const maxRoutes =
    typeof rawConfig?.maxRoutes === "number" && Number.isFinite(rawConfig.maxRoutes)
      ? Math.max(1, Math.min(5, Math.trunc(rawConfig.maxRoutes)))
      : 3;
  const routes = resolveRoutes(__dirname, rawConfig?.routes);
  const routeNames = listRouteNames(routes);
  const defaultRouteCandidate = normalizeRouteName(rawConfig?.defaultRoute) ?? "general";
  const defaultRoute = routeNames.includes(defaultRouteCandidate)
    ? defaultRouteCandidate
    : routeNames.includes("general")
      ? "general"
      : routeNames[0];

  const recallSoftBudgetTokens =
    typeof rawConfig?.recallSoftBudgetTokens === "number" && Number.isFinite(rawConfig.recallSoftBudgetTokens)
      ? Math.max(0, Math.trunc(rawConfig.recallSoftBudgetTokens))
      : 400;
  const recallHardBudgetTokens =
    typeof rawConfig?.recallHardBudgetTokens === "number" && Number.isFinite(rawConfig.recallHardBudgetTokens)
      ? Math.max(0, Math.trunc(rawConfig.recallHardBudgetTokens))
      : 600;

  return {
    enabledAgents,
    corePromptFiles,
    commonPromptFiles,
    classifierModel,
    defaultRoute,
    llmTimeoutMs,
    maxRoutes,
    routes,
    recallSoftBudgetTokens,
    recallHardBudgetTokens,
  };
}

function shouldApplyToAgent(enabledAgents, agentId) {
  if (!enabledAgents || enabledAgents.length === 0) {
    return true;
  }
  if (!agentId) {
    return false;
  }
  return enabledAgents.includes(agentId);
}

function isInternalClassifierSession(event, ctx) {
  const sessionId = typeof ctx?.sessionId === "string" ? ctx.sessionId.trim() : "";
  if (sessionId.startsWith("orchestrator-classifier-")) {
    return true;
  }

  const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  if (sessionKey.startsWith("orchestrator-classifier-")) {
    return true;
  }

  const prompt = typeof event?.prompt === "string" ? event.prompt : "";
  return prompt.includes("You are a route classifier.") && prompt.includes("USER_REQUEST:");
}

function stringifyMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          if (typeof item.text === "string") {
            return item.text;
          }
          if (typeof item.content === "string") {
            return item.content;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      return content.text;
    }
    if (typeof content.content === "string") {
      return content.content;
    }
  }
  return "";
}

function extractLatestUserText(event) {
  if (typeof event?.prompt === "string" && event.prompt.trim().length > 0) {
    return event.prompt.trim();
  }

  if (!Array.isArray(event?.messages)) {
    return "";
  }

  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index];
    if (!message || typeof message !== "object") {
      continue;
    }

    const role =
      typeof message.role === "string"
        ? message.role
        : typeof message?.info?.role === "string"
          ? message.info.role
          : undefined;

    if (role !== "user") {
      continue;
    }

    const directContent = stringifyMessageContent(message.content);
    if (directContent.trim().length > 0) {
      return directContent.trim();
    }

    if (Array.isArray(message.parts)) {
      const partText = message.parts
        .map((part) => stringifyMessageContent(part))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (partText.length > 0) {
        return partText;
      }
    }
  }

  return "";
}

async function readPromptForRoute(routeConfig, logger) {
  try {
    return await fs.readFile(routeConfig.promptFile, "utf8");
  } catch (error) {
    logger?.warn?.(
      `[orchestrator] failed to read prompt for route ${routeConfig.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function readPromptFile(promptFile, logger, label = "prompt") {
  try {
    return await fs.readFile(promptFile, "utf8");
  } catch (error) {
    logger?.warn?.(
      `[orchestrator] failed to read ${label} file ${promptFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function buildSystemContext({ promptBlocks }) {
  return promptBlocks.join("\n\n").trim();
}

/** @type {import("./src/recall/candidates.js").RecallProvider[]} */
const recallProviders = [];

const plugin = {
  id: "orchestrator",
  name: "Orchestrator",
  description: "Prompt router for selected agents with optional LLM-based route classification.",

  /**
   * Register an external recall provider (called by vestige-bridge, memory-cognee-revised, etc.).
   * @param {import("./src/recall/candidates.js").RecallProvider} provider
   */
  registerRecallProvider(provider) {
    if (!provider || typeof provider.recall !== "function" || !provider.id) {
      return;
    }
    // Prevent duplicate registration
    if (recallProviders.some((p) => p.id === provider.id)) {
      return;
    }
    recallProviders.push(provider);
  },

  register(api) {
    const pluginConfig = resolvePluginConfig(api.pluginConfig ?? {});

    api.on("before_prompt_build", async (event, ctx) => {
      if (isInternalClassifierSession(event, ctx)) {
        api.logger.debug?.("[orchestrator] skipping internal classifier session");
        return;
      }

      if (!shouldApplyToAgent(pluginConfig.enabledAgents, ctx?.agentId)) {
        return;
      }

      const inputText = extractLatestUserText(event);
      let classification = {
        source: "core_common_only",
        reason: inputText ? "route_unavailable" : "no_input_text",
      };
      let routes = [];

      if (inputText) {
        classification = await classifyRoutes({
          inputText,
          routes: pluginConfig.routes,
          defaultRoute: pluginConfig.defaultRoute,
          classifierModel: pluginConfig.classifierModel,
          llmTimeoutMs: pluginConfig.llmTimeoutMs,
          maxRoutes: pluginConfig.maxRoutes,
          config: api.config,
          agentId: ctx?.agentId,
          workspaceDir: ctx?.workspaceDir,
          logger: api.logger,
        });

        routes = Array.isArray(classification.routes)
          ? classification.routes
              .map((route) => normalizeRouteName(route))
              .filter((route) => Boolean(route && pluginConfig.routes[route]))
          : [];
        if (routes.length === 0) {
          routes.push(pluginConfig.defaultRoute);
        }
      }

      const promptFiles = [];
      const seenPromptFiles = new Set();
      const addPromptFile = (promptFile) => {
        if (typeof promptFile !== "string" || promptFile.length === 0 || seenPromptFiles.has(promptFile)) {
          return;
        }
        seenPromptFiles.add(promptFile);
        promptFiles.push(promptFile);
      };

      for (const promptFile of pluginConfig.corePromptFiles) {
        addPromptFile(promptFile);
      }
      for (const promptFile of pluginConfig.commonPromptFiles) {
        addPromptFile(promptFile);
      }
      for (const route of routes) {
        addPromptFile(pluginConfig.routes[route]?.promptFile);
      }

      const promptBlocks = (
        await Promise.all(
          promptFiles.map((promptFile) => {
            const routeConfig = Object.values(pluginConfig.routes).find((route) => route.promptFile === promptFile);
            if (routeConfig) {
              return readPromptForRoute(routeConfig, api.logger);
            }
            return readPromptFile(promptFile, api.logger, "global");
          }),
        )
      ).filter(Boolean);

      // --- Memory recall composition ---
      const recallResult = await runRecallPipeline({
        providers: recallProviders,
        latestUserTurn: inputText,
        messages: event?.messages,
        routeHint: routes[0],
        projectHint: ctx?.workspaceDir ? path.basename(ctx.workspaceDir) : undefined,
        softBudgetTokens: pluginConfig.recallSoftBudgetTokens,
        hardBudgetTokens: pluginConfig.recallHardBudgetTokens,
        logger: api.logger,
      });

      if (promptBlocks.length === 0 && !recallResult.packet) {
        return;
      }

      api.logger.info(
        `[orchestrator] agent=${String(ctx?.agentId ?? "unknown")} routes=${routes.join(",") || "none"} source=${classification.source} recall=${recallResult.candidateCount}/${recallResult.dropped}dropped/${recallResult.totalTokens}tok`,
      );

      const result = {};
      if (promptBlocks.length > 0) {
        result.appendSystemContext = buildSystemContext({ promptBlocks });
      }
      if (recallResult.packet) {
        result.prependContext = recallResult.packet;
      }

      return result;
    });
  },
};

export default plugin;
export { listRouteDescriptions, listRouteNames };
export { runRecallPipeline, composeRecallPacket, makeCandidate } from "./src/recall/index.js";
