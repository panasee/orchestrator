import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRecallQuery, buildTailSummary } from "../src/recall/query-builder.js";

describe("buildTailSummary", () => {
  it("returns empty string for empty or missing messages", () => {
    assert.equal(buildTailSummary([]), "");
    assert.equal(buildTailSummary(null), "");
    assert.equal(buildTailSummary(undefined), "");
  });

  it("summarizes recent messages with role prefixes", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const summary = buildTailSummary(messages);
    assert.ok(summary.includes("user: Hello"));
    assert.ok(summary.includes("assistant: Hi there"));
  });

  it("truncates long message content", () => {
    const messages = [{ role: "user", content: "x".repeat(200) }];
    const summary = buildTailSummary(messages);
    assert.ok(summary.includes("..."));
    assert.ok(summary.length < 200);
  });

  it("limits to last 6 messages", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg${i}`,
    }));
    const summary = buildTailSummary(messages);
    // Should not include early messages
    assert.ok(!summary.includes("msg0"));
    assert.ok(!summary.includes("msg3"));
    // Should include later messages
    assert.ok(summary.includes("msg9"));
  });

  it("handles array content format", () => {
    const messages = [{ role: "user", content: [{ text: "part1" }, { text: "part2" }] }];
    const summary = buildTailSummary(messages);
    assert.ok(summary.includes("part1"));
    assert.ok(summary.includes("part2"));
  });
});

describe("buildRecallQuery", () => {
  it("builds query from user turn only", () => {
    const q = buildRecallQuery({ latestUserTurn: "What is X?" });
    assert.equal(q.latestUserTurn, "What is X?");
    assert.ok(q.queryText.includes("What is X?"));
    assert.equal(q.tailSummary, undefined);
    assert.equal(q.routeHint, undefined);
    assert.equal(q.projectHint, undefined);
  });

  it("includes route and project hints", () => {
    const q = buildRecallQuery({
      latestUserTurn: "Fix the bug",
      routeHint: "code_mod",
      projectHint: "orchestrator",
    });
    assert.ok(q.queryText.includes("[route: code_mod]"));
    assert.ok(q.queryText.includes("[project: orchestrator]"));
    assert.equal(q.routeHint, "code_mod");
    assert.equal(q.projectHint, "orchestrator");
  });

  it("includes tail summary from messages", () => {
    const q = buildRecallQuery({
      latestUserTurn: "Next step?",
      messages: [
        { role: "user", content: "Start project" },
        { role: "assistant", content: "Sure, beginning..." },
      ],
    });
    assert.ok(q.tailSummary);
    assert.ok(q.queryText.includes("[context:"));
  });

  it("handles empty user turn gracefully", () => {
    const q = buildRecallQuery({ latestUserTurn: "" });
    assert.equal(q.latestUserTurn, "");
    assert.equal(q.queryText, "");
  });
});
