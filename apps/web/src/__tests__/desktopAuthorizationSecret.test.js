import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureDesktopAuthorizationSecret,
  clearDesktopAuthorizationSecret,
  readDesktopAuthorizationSecret,
} from "../lib/desktopAuthorizationSecret";

const SECRET = "a".repeat(43);

describe("desktop authorization URL secrets", () => {
  beforeEach(() => {
    clearDesktopAuthorizationSecret();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("captures a valid fragment before telemetry and removes it from the visible URL", () => {
    window.history.pushState({}, "", `/desktop/authorize#request=${SECRET}`);

    expect(captureDesktopAuthorizationSecret()).toBe(SECRET);
    expect(window.location.pathname).toBe("/desktop/authorize");
    expect(window.location.hash).toBe("");
    expect(readDesktopAuthorizationSecret()).toBe(SECRET);

    clearDesktopAuthorizationSecret();
    expect(readDesktopAuthorizationSecret()).toBeNull();
  });

  it("rejects and clears malformed or ambiguous request fragments", () => {
    window.history.pushState({}, "", `/desktop/authorize#request=${SECRET}`);
    expect(captureDesktopAuthorizationSecret()).toBe(SECRET);

    window.history.replaceState({}, "", `/desktop/authorize#request=${SECRET}&next=/admin`);
    expect(captureDesktopAuthorizationSecret()).toBeNull();
    expect(window.location.hash).toBe("");
    expect(readDesktopAuthorizationSecret()).toBeNull();
  });

  it("keeps the secret only in memory and never writes browser storage", () => {
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    window.history.pushState({}, "", `/desktop/authorize#request=${SECRET}`);
    captureDesktopAuthorizationSecret();

    expect(readDesktopAuthorizationSecret()).toBe(SECRET);
    expect(storageSpy).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    storageSpy.mockRestore();
  });
});
