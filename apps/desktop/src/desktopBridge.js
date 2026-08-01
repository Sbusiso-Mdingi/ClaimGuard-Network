function invokeThroughTauri(command, args) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") throw new Error("ClaimGuard desktop commands are unavailable outside the trusted application shell.");
  return invoke(command, args);
}

let invokeImplementation = invokeThroughTauri;

export function setDesktopInvokeForTests(implementation) {
  invokeImplementation = implementation;
}

export const desktopBridge = Object.freeze({
  status: () => invokeImplementation("desktop_status"),
  activate: (activationKey) => invokeImplementation("activate_desktop", { activationKey }),
  login: (username, password) => invokeImplementation("desktop_login", { username, password }),
  logout: () => invokeImplementation("desktop_logout"),
  lock: () => invokeImplementation("lock_desktop"),
  sync: () => invokeImplementation("synchronize_desktop"),
  claimDetails: (claimId) => invokeImplementation("desktop_claim_details", { claimId }),
  reset: (confirmation) => invokeImplementation("reset_desktop", { confirmation }),
});

export function pollingDelay(baseMs, random = Math.random) {
  const jitter = 0.8 + random() * 0.4;
  return Math.round(baseMs * jitter);
}

export function nextBackoff(attempt, { active = true, random = Math.random } = {}) {
  const base = active ? 15_000 : 60_000;
  const ceiling = active ? 120_000 : 15 * 60_000;
  return pollingDelay(Math.min(ceiling, base * (2 ** Math.max(0, attempt))), random);
}

export function operationalWriteAllowed(status) {
  return Boolean(status?.authenticated && !status?.locked && ["Fresh", "Synchronizing"].includes(status?.cache?.freshness));
}
