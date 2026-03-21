import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import plugin from "../index.js";
import { clearSharedRecallProviders, registerSharedRecallProvider } from "../src/recall/index.js";

describe("orchestrator shared-provider integration", () => {
  beforeEach(() => {
    clearSharedRecallProviders();
  });

  it("injects recall from a shared provider into prependContext and prependSystemContext", async () => {
    const handlers = new Map();
    const logs = [];

    const api = {
      pluginConfig: {
        enabledAgents: [],
        corePromptFiles: [],
        commonPromptFiles: [],
        routes: {},
        recallSoftBudgetTokens: 950,
        recallHardBudgetTokens: 1200,
        recallSystemGuidance: true,
      },
      logger: {
        info: (msg) => logs.push(msg),
        warn: () => {},
        debug: () => {},
      },
      config: {},
      on(name, handler) {
        handlers.set(name, handler);
      },
    };

    plugin.register(api);

    registerSharedRecallProvider({
      id: "test-stable-provider",
      lane: "stable",
      async recall(query) {
        return [
          {
            canonicalKey: "shared:rule-1",
            lane: "stable",
            bucket: "global_constraints",
            score: 0.95,
            tokenEstimate: 12,
            text: `- Shared stable rule for ${query.latestUserTurn}`,
            provider: "test-stable-provider",
          },
        ];
      },
    });

    const beforePromptBuild = handlers.get("before_prompt_build");
    assert.equal(typeof beforePromptBuild, "function");

    const result = await beforePromptBuild(
      {
        prompt: "Need the current memory rules",
        messages: [{ role: "user", content: "Need the current memory rules" }],
      },
      {
        agentId: "main",
        workspaceDir: "/home/dongkai-claw/workspace/orchestrator",
      },
    );

    assert.ok(result);
    assert.match(result.prependContext, /<cognee_recall>/);
    assert.match(result.prependContext, /Shared stable rule for Need the current memory rules/);
    assert.match(result.prependSystemContext, /<vestige_recent>/);
    assert.ok(logs.some((line) => line.includes("recall=1/0dropped/12tok")));
  });

  it("can disable recall system guidance while still injecting recall packet", async () => {
    const handlers = new Map();
    const api = {
      pluginConfig: {
        enabledAgents: [],
        corePromptFiles: [],
        commonPromptFiles: [],
        routes: {},
        recallSystemGuidance: false,
      },
      logger: {
        info: () => {},
        warn: () => {},
        debug: () => {},
      },
      config: {},
      on(name, handler) {
        handlers.set(name, handler);
      },
    };

    plugin.register(api);

    registerSharedRecallProvider({
      id: "test-recent-provider",
      lane: "recent",
      async recall() {
        return [
          {
            canonicalKey: "recent:1",
            lane: "recent",
            bucket: "recent_preference",
            score: 0.7,
            tokenEstimate: 10,
            text: "- [recent_preference] Recent preference from shared provider.",
            provider: "test-recent-provider",
          },
        ];
      },
    });

    const result = await handlers.get("before_prompt_build")(
      {
        prompt: "What changed recently?",
        messages: [{ role: "user", content: "What changed recently?" }],
      },
      { agentId: "main", workspaceDir: "/tmp/orchestrator" },
    );

    assert.ok(result.prependContext.includes("<vestige_recent>"));
    assert.equal(result.prependSystemContext, undefined);
  });
});
