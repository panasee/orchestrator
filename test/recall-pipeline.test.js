import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRecallPipeline, RECALL_SYSTEM_GUIDANCE } from "../src/recall/index.js";
import { makeCandidate, createNoopProvider } from "../src/recall/candidates.js";

describe("runRecallPipeline", () => {
  it("returns empty packet when no providers registered", async () => {
    const result = await runRecallPipeline({
      providers: [],
      latestUserTurn: "Hello",
    });
    assert.equal(result.packet, "");
    assert.equal(result.candidateCount, 0);
  });

  it("returns empty packet when latestUserTurn is empty", async () => {
    const provider = createNoopProvider();
    const result = await runRecallPipeline({
      providers: [provider],
      latestUserTurn: "",
    });
    assert.equal(result.packet, "");
  });

  it("collects candidates from a mock provider", async () => {
    const mockProvider = {
      id: "mock-stable",
      lane: "stable",
      async recall(query) {
        return [
          makeCandidate({
            canonicalKey: "mock:1",
            lane: "stable",
            bucket: "active_project_stable",
            score: 0.9,
            text: `Recalled for: ${query.latestUserTurn}`,
            provider: "mock-stable",
            tokenEstimate: 20,
          }),
        ];
      },
    };

    const result = await runRecallPipeline({
      providers: [mockProvider],
      latestUserTurn: "What are my preferences?",
    });

    assert.equal(result.candidateCount, 1);
    assert.ok(result.packet.includes("Recalled for: What are my preferences?"));
    assert.ok(result.packet.includes("<cognee_recall>"));
  });

  it("collects from multiple providers and dedupes by lane", async () => {
    const stableProvider = {
      id: "stable",
      lane: "stable",
      async recall() {
        return [
          makeCandidate({
            canonicalKey: "shared:1",
            lane: "stable",
            bucket: "other_stable",
            score: 0.7,
            text: "stable version of shared fact",
            provider: "stable",
            tokenEstimate: 15,
          }),
        ];
      },
    };

    const recentProvider = {
      id: "recent",
      lane: "recent",
      async recall() {
        return [
          makeCandidate({
            canonicalKey: "shared:1",
            lane: "recent",
            bucket: "recent_other",
            score: 0.9,
            text: "recent version of shared fact",
            provider: "recent",
            tokenEstimate: 15,
          }),
          makeCandidate({
            canonicalKey: "recent-only:1",
            lane: "recent",
            bucket: "recent_preference",
            score: 0.6,
            text: "unique recent item",
            provider: "recent",
            tokenEstimate: 10,
          }),
        ];
      },
    };

    const result = await runRecallPipeline({
      providers: [stableProvider, recentProvider],
      latestUserTurn: "Tell me about X",
    });

    assert.equal(result.candidateCount, 2);
    // Stable wins dedupe over recent for shared:1
    assert.ok(result.packet.includes("stable version of shared fact"));
    assert.ok(!result.packet.includes("recent version of shared fact"));
    assert.ok(result.packet.includes("unique recent item"));
  });

  it("handles provider failure gracefully (fail-soft)", async () => {
    const failingProvider = {
      id: "failing",
      lane: "recent",
      async recall() {
        throw new Error("provider crashed");
      },
    };

    const goodProvider = {
      id: "good",
      lane: "stable",
      async recall() {
        return [
          makeCandidate({
            canonicalKey: "good:1",
            lane: "stable",
            bucket: "global_constraints",
            score: 0.8,
            text: "good result",
            provider: "good",
            tokenEstimate: 10,
          }),
        ];
      },
    };

    const warnings = [];
    const logger = { warn: (msg) => warnings.push(msg) };

    const result = await runRecallPipeline({
      providers: [failingProvider, goodProvider],
      latestUserTurn: "test",
      logger,
    });

    assert.equal(result.candidateCount, 1);
    assert.ok(result.packet.includes("good result"));
    assert.ok(warnings.some((w) => w.includes("failing") && w.includes("crashed")));
  });

  it("passes query with route and project hints to providers", async () => {
    let capturedQuery = null;
    const spyProvider = {
      id: "spy",
      lane: "recent",
      async recall(query) {
        capturedQuery = query;
        return [];
      },
    };

    await runRecallPipeline({
      providers: [spyProvider],
      latestUserTurn: "Fix bug",
      routeHint: "code_mod",
      projectHint: "orchestrator",
      messages: [{ role: "user", content: "Fix bug" }],
    });

    assert.ok(capturedQuery);
    assert.equal(capturedQuery.latestUserTurn, "Fix bug");
    assert.equal(capturedQuery.routeHint, "code_mod");
    assert.equal(capturedQuery.projectHint, "orchestrator");
    assert.ok(capturedQuery.queryText.includes("[route: code_mod]"));
    assert.ok(capturedQuery.queryText.includes("[project: orchestrator]"));
  });
});

describe("RECALL_SYSTEM_GUIDANCE", () => {
  it("is a non-empty string mentioning both memory blocks", () => {
    assert.ok(typeof RECALL_SYSTEM_GUIDANCE === "string");
    assert.ok(RECALL_SYSTEM_GUIDANCE.length > 0);
    assert.ok(RECALL_SYSTEM_GUIDANCE.includes("<cognee_recall>"));
    assert.ok(RECALL_SYSTEM_GUIDANCE.includes("<vestige_recent>"));
  });
});
