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
    bucket: "recent",
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

  it("dedupes by canonicalKey, favoring stable over recent", () => {
    const candidates = [
      c({ canonicalKey: "x", bucket: "recent", score: 0.9, isStable: false }),
      c({ canonicalKey: "x", bucket: "stable", score: 0.5, isStable: true }),
    ];
    const result = dedupeCandidates(candidates);
    assert.equal(result.length, 1);
    assert.equal(result[0].bucket, "stable");
    assert.equal(result[0].isStable, true);
  });

  it("dedupes same-bucket by higher score", () => {
    const candidates = [
      c({ canonicalKey: "x", bucket: "recent", score: 0.3 }),
      c({ canonicalKey: "x", bucket: "recent", score: 0.8 }),
    ];
    const result = dedupeCandidates(candidates);
    assert.equal(result.length, 1);
    assert.equal(result[0].score, 0.8);
  });
});

describe("sortCandidates", () => {
  it("sorts stable before recent", () => {
    const candidates = [c({ bucket: "recent", score: 0.9 }), c({ bucket: "stable", score: 0.3 })];
    const sorted = sortCandidates(candidates);
    assert.equal(sorted[0].bucket, "stable");
    assert.equal(sorted[1].bucket, "recent");
  });

  it("sorts by score descending within same bucket", () => {
    const candidates = [
      c({ canonicalKey: "a", bucket: "stable", score: 0.3 }),
      c({ canonicalKey: "b", bucket: "stable", score: 0.9 }),
    ];
    const sorted = sortCandidates(candidates);
    assert.equal(sorted[0].score, 0.9);
    assert.equal(sorted[1].score, 0.3);
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
});

describe("renderRecallPacket", () => {
  it("returns empty string for no candidates", () => {
    assert.equal(renderRecallPacket([]), "");
  });

  it("wraps stable candidates in cognee_recall tags", () => {
    const result = renderRecallPacket([c({ bucket: "stable", text: "stable fact" })]);
    assert.ok(result.includes("<cognee_recall>"));
    assert.ok(result.includes("stable fact"));
    assert.ok(result.includes("</cognee_recall>"));
  });

  it("wraps recent candidates in vestige_recent tags", () => {
    const result = renderRecallPacket([c({ bucket: "recent", text: "recent fact" })]);
    assert.ok(result.includes("<vestige_recent>"));
    assert.ok(result.includes("recent fact"));
    assert.ok(result.includes("</vestige_recent>"));
  });

  it("renders both sections when mixed", () => {
    const result = renderRecallPacket([
      c({ bucket: "stable", text: "S1" }),
      c({ bucket: "recent", text: "R1" }),
    ]);
    assert.ok(result.includes("<cognee_recall>"));
    assert.ok(result.includes("<vestige_recent>"));
    // Stable should appear before recent
    assert.ok(result.indexOf("<cognee_recall>") < result.indexOf("<vestige_recent>"));
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
      c({ canonicalKey: "dup", bucket: "recent", score: 0.8, text: "recent version", tokenEstimate: 10 }),
      c({ canonicalKey: "dup", bucket: "stable", score: 0.5, text: "stable version", tokenEstimate: 10, isStable: true }),
      c({ canonicalKey: "unique", bucket: "recent", score: 0.6, text: "unique recent", tokenEstimate: 10 }),
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
      c({ canonicalKey: "a", bucket: "stable", score: 0.9, text: "a".repeat(400), tokenEstimate: 100 }),
      c({ canonicalKey: "b", bucket: "recent", score: 0.5, text: "b".repeat(2000), tokenEstimate: 500 }),
    ];
    const result = composeRecallPacket(candidates, { softBudgetTokens: 100, hardBudgetTokens: 200 });
    assert.equal(result.candidateCount, 1);
    assert.equal(result.dropped, 1);
  });
});
