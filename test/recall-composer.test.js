import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeCandidates,
  sortCandidates,
  packCandidates,
  renderRecallPacket,
  composeRecallPacket,
} from "../src/recall/composer.js";
import { makeCandidate } from "../src/recall/candidates.js";

function c(overrides) {
  return makeCandidate({
    canonicalKey: "k1",
    lane: "recent",
    bucket: "recent_other",
    score: 0.5,
    text: "test content",
    provider: "test",
    ...overrides,
  });
}

describe("dedupeCandidates", () => {
  it("keeps unique candidates", () => {
    const candidates = [c({ canonicalKey: "a" }), c({ canonicalKey: "b" })];
    assert.equal(dedupeCandidates(candidates).length, 2);
  });

  it("dedupes by canonicalKey, favoring stable lane over recent", () => {
    const candidates = [
      c({ canonicalKey: "x", lane: "recent", bucket: "recent_other", score: 0.9 }),
      c({ canonicalKey: "x", lane: "stable", bucket: "other_stable", score: 0.5 }),
    ];
    const result = dedupeCandidates(candidates);
    assert.equal(result.length, 1);
    assert.equal(result[0].lane, "stable");
  });

  it("dedupes same-lane by higher score", () => {
    const candidates = [
      c({ canonicalKey: "x", lane: "recent", score: 0.3 }),
      c({ canonicalKey: "x", lane: "recent", score: 0.8 }),
    ];
    const result = dedupeCandidates(candidates);
    assert.equal(result.length, 1);
    assert.equal(result[0].score, 0.8);
  });
});

describe("sortCandidates", () => {
  it("sorts by bucket priority first", () => {
    const candidates = [
      c({ canonicalKey: "a", bucket: "recent_other", lane: "recent", score: 0.9 }),
      c({ canonicalKey: "b", bucket: "active_project_stable", lane: "stable", score: 0.3 }),
    ];
    const sorted = sortCandidates(candidates);
    assert.equal(sorted[0].bucket, "active_project_stable");
    assert.equal(sorted[1].bucket, "recent_other");
  });

  it("sorts stable lane before recent lane within same bucket priority", () => {
    const candidates = [
      c({ canonicalKey: "a", lane: "recent", bucket: "other_stable", score: 0.9 }),
      c({ canonicalKey: "b", lane: "stable", bucket: "other_stable", score: 0.3 }),
    ];
    const sorted = sortCandidates(candidates);
    assert.equal(sorted[0].lane, "stable");
    assert.equal(sorted[1].lane, "recent");
  });

  it("sorts by score descending within same bucket and lane", () => {
    const candidates = [
      c({ canonicalKey: "a", lane: "stable", bucket: "other_stable", score: 0.3 }),
      c({ canonicalKey: "b", lane: "stable", bucket: "other_stable", score: 0.9 }),
    ];
    const sorted = sortCandidates(candidates);
    assert.equal(sorted[0].score, 0.9);
    assert.equal(sorted[1].score, 0.3);
  });

  it("unknown buckets sort after known ones", () => {
    const candidates = [
      c({ canonicalKey: "a", bucket: "custom_unknown", lane: "stable", score: 0.9 }),
      c({ canonicalKey: "b", bucket: "global_constraints", lane: "stable", score: 0.3 }),
    ];
    const sorted = sortCandidates(candidates);
    assert.equal(sorted[0].bucket, "global_constraints");
    assert.equal(sorted[1].bucket, "custom_unknown");
  });
});

describe("packCandidates", () => {
  it("packs candidates within soft budget", () => {
    const candidates = [
      c({ canonicalKey: "a", tokenEstimate: 100 }),
      c({ canonicalKey: "b", tokenEstimate: 100 }),
    ];
    const { packed, totalTokens, dropped } = packCandidates(candidates, {
      softBudgetTokens: 250,
      hardBudgetTokens: 300,
    });
    assert.equal(packed.length, 2);
    assert.equal(totalTokens, 200);
    assert.equal(dropped, 0);
  });

  it("allows overflow into hard budget", () => {
    const candidates = [
      c({ canonicalKey: "a", tokenEstimate: 300 }),
      c({ canonicalKey: "b", tokenEstimate: 200 }),
    ];
    const { packed, dropped } = packCandidates(candidates, {
      softBudgetTokens: 300,
      hardBudgetTokens: 600,
    });
    assert.equal(packed.length, 2);
    assert.equal(dropped, 0);
  });

  it("drops candidates exceeding hard budget", () => {
    const candidates = [
      c({ canonicalKey: "a", tokenEstimate: 400 }),
      c({ canonicalKey: "b", tokenEstimate: 300 }),
    ];
    const { packed, dropped } = packCandidates(candidates, {
      softBudgetTokens: 400,
      hardBudgetTokens: 500,
    });
    assert.equal(packed.length, 1);
    assert.equal(dropped, 1);
  });

  it("returns empty for empty input", () => {
    const { packed, totalTokens } = packCandidates([]);
    assert.equal(packed.length, 0);
    assert.equal(totalTokens, 0);
  });

  it("uses spec defaults (950/1200) when no budgets provided", () => {
    // 10 candidates of 100 tokens each = 1000, which exceeds 950 soft but fits 1200 hard
    const candidates = Array.from({ length: 10 }, (_, i) =>
      c({ canonicalKey: `item-${i}`, tokenEstimate: 100 }),
    );
    const { packed, totalTokens } = packCandidates(candidates);
    assert.equal(packed.length, 10);
    assert.equal(totalTokens, 1000);
  });
});

describe("renderRecallPacket", () => {
  it("returns empty string for no candidates", () => {
    assert.equal(renderRecallPacket([]), "");
  });

  it("wraps stable memory candidates in cognee_memory tags", () => {
    const result = renderRecallPacket([
      c({ lane: "stable", bucket: "other_stable", text: "stable fact", meta: { dataset: "memory" } }),
    ]);
    assert.ok(result.includes("<cognee_memory>"));
    assert.ok(result.includes("stable fact"));
    assert.ok(result.includes("</cognee_memory>"));
  });

  it("wraps stable library candidates in cognee_library tags", () => {
    const result = renderRecallPacket([
      c({ lane: "stable", bucket: "library_reference", text: "library fact", meta: { dataset: "library" } }),
    ]);
    assert.ok(result.includes("<cognee_library>"));
    assert.ok(result.includes("library fact"));
    assert.ok(result.includes("</cognee_library>"));
  });

  it("wraps recent lane candidates in vestige_recent tags", () => {
    const result = renderRecallPacket([c({ lane: "recent", bucket: "recent_other", text: "recent fact" })]);
    assert.ok(result.includes("<vestige_recent>"));
    assert.ok(result.includes("recent fact"));
    assert.ok(result.includes("</vestige_recent>"));
  });

  it("renders separate memory/library/recent sections when mixed lanes", () => {
    const result = renderRecallPacket([
      c({ lane: "stable", bucket: "other_stable", text: "M1", meta: { dataset: "memory" } }),
      c({ lane: "stable", bucket: "library_reference", text: "L1", meta: { dataset: "library" } }),
      c({ lane: "recent", bucket: "recent_other", text: "R1" }),
    ]);
    assert.ok(result.includes("<cognee_memory>"));
    assert.ok(result.includes("<cognee_library>"));
    assert.ok(result.includes("<vestige_recent>"));
    assert.ok(result.indexOf("<cognee_memory>") < result.indexOf("<cognee_library>"));
    assert.ok(result.indexOf("<cognee_library>") < result.indexOf("<vestige_recent>"));
  });
});

describe("composeRecallPacket (full pipeline)", () => {
  it("returns empty for no candidates", () => {
    const result = composeRecallPacket([]);
    assert.equal(result.packet, "");
    assert.equal(result.candidateCount, 0);
    assert.equal(result.dropped, 0);
  });

  it("dedupes, sorts, packs, and renders", () => {
    const candidates = [
      c({ canonicalKey: "dup", lane: "recent", bucket: "recent_other", score: 0.8, text: "recent version", tokenEstimate: 10 }),
      c({ canonicalKey: "dup", lane: "stable", bucket: "other_stable", score: 0.5, text: "stable version", tokenEstimate: 10 }),
      c({ canonicalKey: "unique", lane: "recent", bucket: "recent_other", score: 0.6, text: "unique recent", tokenEstimate: 10 }),
    ];
    const result = composeRecallPacket(candidates, { softBudgetTokens: 100, hardBudgetTokens: 200 });

    assert.equal(result.candidateCount, 2);
    assert.equal(result.dropped, 0);
    // "dup" should resolve to stable version
    assert.ok(result.packet.includes("stable version"));
    assert.ok(!result.packet.includes("recent version"));
    assert.ok(result.packet.includes("unique recent"));
  });

  it("respects hard budget and drops overflow", () => {
    const candidates = [
      c({ canonicalKey: "a", lane: "stable", bucket: "active_project_stable", score: 0.9, text: "a".repeat(400), tokenEstimate: 100 }),
      c({ canonicalKey: "b", lane: "recent", bucket: "recent_other", score: 0.5, text: "b".repeat(2000), tokenEstimate: 500 }),
    ];
    const result = composeRecallPacket(candidates, { softBudgetTokens: 100, hardBudgetTokens: 200 });
    assert.equal(result.candidateCount, 1);
    assert.equal(result.dropped, 1);
  });
});
