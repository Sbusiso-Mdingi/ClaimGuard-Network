import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function runWithOperationalServices(bundle, operation) {
  return storage.run(bundle, operation);
}

export function getOperationalServices() {
  return storage.getStore() || null;
}

export function createOperationalDependencyProxy(key, fallback = null) {
  return new Proxy({}, {
    get(_target, property) {
      const dependency = getOperationalServices()?.[key] || fallback;
      const value = dependency?.[property];
      return typeof value === "function" ? value.bind(dependency) : value;
    },
  });
}
