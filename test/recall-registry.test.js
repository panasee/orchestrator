import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearSharedRecallProviders,
  listSharedRecallProviders,
  registerSharedRecallProvider,
} from "../src/recall/index.js";

describe("shared recall registry", () => {
  beforeEach(() => {
    clearSharedRecallProviders();
  });

  it("registers and lists shared providers", () => {
    const provider = {
      id: "shared-stable",
      lane: "stable",
      async recall() {
        return [];
      },
    };

    assert.equal(registerSharedRecallProvider(provider), true);

    const listed = listSharedRecallProviders();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, "shared-stable");
  });

  it("merges local and shared providers without duplicate ids", () => {
    const shared = {
      id: "shared-provider",
      lane: "recent",
      async recall() {
        return [];
      },
    };
    const local = {
      id: "local-provider",
      lane: "stable",
      async recall() {
        return [];
      },
    };
    const duplicateLocal = {
      id: "shared-provider",
      lane: "stable",
      async recall() {
        return [];
      },
    };

    registerSharedRecallProvider(shared);
    const listed = listSharedRecallProviders([local, duplicateLocal]);

    assert.deepEqual(
      listed.map((provider) => provider.id).sort(),
      ["local-provider", "shared-provider"],
    );
    assert.equal(listed.find((provider) => provider.id === "shared-provider"), duplicateLocal);
  });
});
