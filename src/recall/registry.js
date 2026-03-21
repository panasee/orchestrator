/**
 * Shared in-process recall provider registry.
 *
 * Provider plugins live in separate repos/packages, so we use a tiny global
 * registry keyed off Symbol.for(...) instead of direct imports between plugins.
 */

const REGISTRY_KEY = Symbol.for("openclaw.recallProviders");

function getRegistryMap() {
  if (!globalThis[REGISTRY_KEY]) {
    globalThis[REGISTRY_KEY] = new Map();
  }
  return globalThis[REGISTRY_KEY];
}

export function registerSharedRecallProvider(provider) {
  if (!provider || typeof provider.recall !== "function" || !provider.id) {
    return false;
  }
  getRegistryMap().set(provider.id, provider);
  return true;
}

export function listSharedRecallProviders(localProviders = []) {
  const merged = new Map();

  for (const provider of Array.isArray(localProviders) ? localProviders : []) {
    if (provider && typeof provider.recall === "function" && provider.id) {
      merged.set(provider.id, provider);
    }
  }

  for (const provider of getRegistryMap().values()) {
    if (provider && typeof provider.recall === "function" && provider.id && !merged.has(provider.id)) {
      merged.set(provider.id, provider);
    }
  }

  return Array.from(merged.values());
}

export function clearSharedRecallProviders() {
  getRegistryMap().clear();
}
