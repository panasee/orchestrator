import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeCandidate, estimateTokens, createNoopProvider, bucketPriority, lanePriority, BUCKET_PRIORITY_ORDER } from "../src/recall/candidates.js";

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

describe("bucketPriority", () => {
  it("returns correct priority for known buckets", () => {
    assert.equal(bucketPriority("active_project_stable"), 0);
    assert.equal(bucketPriority("global_constraints"), 1);
    assert.equal(bucketPriority("recent_other"), BUCKET_PRIORITY_ORDER.length - 1);
  });

  it("returns high priority number for unknown buckets", () => {
    assert.equal(bucketPriority("custom_unknown"), BUCKET_PRIORITY_ORDER.length);
  });
});

describe("lanePriority", () => {
  it("stable has higher priority than recent", () => {
    assert.ok(lanePriority("stable") < lanePriority("recent"));
  });

  it("unknown lanes default to recent priority", () => {
    assert.equal(lanePriority("invalid"), lanePriority("recent"));
  });
});

describe("makeCandidate", () => {
  it("fills defaults for minimal input with explicit lane", () => {
    const c = makeCandidate({
      canonicalKey: "test:1",
      lane: "stable",
      bucket: "active_project_stable",
      score: 0.8,
      text: "Hello world",
      provider: "test",
    });

    assert.equal(c.canonicalKey, "test:1");
    assert.equal(c.lane, "stable");
    assert.equal(c.bucket, "active_project_stable");
    assert.equal(c.score, 0.8);
    assert.equal(c.text, "Hello world");
    assert.equal(c.provider, "test");
    assert.equal(c.tokenEstimate, estimateTokens("Hello world"));
    assert.deepEqual(c.meta, {});
  });

  it("infers lane from rich bucket name", () => {
    const c = makeCandidate({
      canonicalKey: "test:2",
      bucket: "global_constraints",
      score: 0.5,
      text: "constraint",
      provider: "test",
    });
    assert.equal(c.lane, "stable");
    assert.equal(c.bucket, "global_constraints");
  });

  it("infers recent lane from recent bucket", () => {
    const c = makeCandidate({
      canonicalKey: "test:3",
      bucket: "recent_preference",
      score: 0.5,
      text: "pref",
      provider: "test",
    });
    assert.equal(c.lane, "recent");
    assert.equal(c.bucket, "recent_preference");
  });

  it("normalizes legacy 'stable' bucket to other_stable with stable lane", () => {
    const c = makeCandidate({
      canonicalKey: "test:4",
      bucket: "stable",
      score: 0.5,
      text: "legacy",
      provider: "test",
    });
    assert.equal(c.lane, "stable");
    assert.equal(c.bucket, "other_stable");
  });

  it("normalizes legacy 'recent' bucket to recent_other with recent lane", () => {
    const c = makeCandidate({
      canonicalKey: "test:5",
      bucket: "recent",
      score: 0.5,
      text: "legacy",
      provider: "test",
    });
    assert.equal(c.lane, "recent");
    assert.equal(c.bucket, "recent_other");
  });

  it("explicit lane overrides bucket inference", () => {
    const c = makeCandidate({
      canonicalKey: "test:6",
      lane: "recent",
      bucket: "active_project_stable",
      score: 0.5,
      text: "override",
      provider: "test",
    });
    assert.equal(c.lane, "recent");
    assert.equal(c.bucket, "active_project_stable");
  });

  it("clamps score to 0-1 range", () => {
    assert.equal(makeCandidate({ canonicalKey: "a", lane: "recent", score: 1.5, text: "" }).score, 1);
    assert.equal(makeCandidate({ canonicalKey: "a", lane: "recent", score: -0.5, text: "" }).score, 0);
  });

  it("uses provided tokenEstimate over auto-estimate", () => {
    const c = makeCandidate({ canonicalKey: "a", lane: "stable", bucket: "other_stable", score: 0.5, text: "hello", tokenEstimate: 42 });
    assert.equal(c.tokenEstimate, 42);
  });

  it("falls back to isStable for lane inference when no lane or rich bucket", () => {
    const c = makeCandidate({
      canonicalKey: "compat:1",
      score: 0.5,
      text: "compat",
      provider: "test",
      isStable: true,
    });
    assert.equal(c.lane, "stable");
  });
});

describe("createNoopProvider", () => {
  it("returns empty array on recall", async () => {
    const provider = createNoopProvider("test-noop", "recent");
    assert.equal(provider.id, "test-noop");
    assert.equal(provider.lane, "recent");
    const result = await provider.recall({ queryText: "test", latestUserTurn: "test" });
    assert.deepEqual(result, []);
  });
});
