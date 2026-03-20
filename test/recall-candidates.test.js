import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeCandidate, estimateTokens, createNoopProvider } from "../src/recall/candidates.js";

describe("estimateTokens", () => {
  it("returns 0 for empty or non-string input", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
  });

  it("estimates roughly 1 token per 4 chars", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
    assert.equal(estimateTokens("a".repeat(100)), 25);
  });
});

describe("makeCandidate", () => {
  it("fills defaults for minimal input", () => {
    const c = makeCandidate({
      canonicalKey: "test:1",
      bucket: "stable",
      score: 0.8,
      text: "Hello world",
      provider: "test",
    });

    assert.equal(c.canonicalKey, "test:1");
    assert.equal(c.bucket, "stable");
    assert.equal(c.score, 0.8);
    assert.equal(c.text, "Hello world");
    assert.equal(c.provider, "test");
    assert.equal(c.isStable, true);
    assert.equal(c.tokenEstimate, estimateTokens("Hello world"));
    assert.deepEqual(c.meta, {});
  });

  it("clamps score to 0-1 range", () => {
    assert.equal(makeCandidate({ canonicalKey: "a", bucket: "recent", score: 1.5, text: "" }).score, 1);
    assert.equal(makeCandidate({ canonicalKey: "a", bucket: "recent", score: -0.5, text: "" }).score, 0);
  });

  it("defaults bucket to recent for invalid values", () => {
    assert.equal(makeCandidate({ canonicalKey: "a", bucket: "invalid", score: 0.5, text: "" }).bucket, "recent");
  });

  it("uses provided tokenEstimate over auto-estimate", () => {
    const c = makeCandidate({ canonicalKey: "a", bucket: "stable", score: 0.5, text: "hello", tokenEstimate: 42 });
    assert.equal(c.tokenEstimate, 42);
  });
});

describe("createNoopProvider", () => {
  it("returns empty array on recall", async () => {
    const provider = createNoopProvider("test-noop", "recent");
    assert.equal(provider.id, "test-noop");
    assert.equal(provider.bucket, "recent");
    const result = await provider.recall({ queryText: "test", latestUserTurn: "test" });
    assert.deepEqual(result, []);
  });
});
