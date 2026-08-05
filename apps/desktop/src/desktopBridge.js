function invokeThroughTauri(command, args) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") throw new Error("ClaimGuard desktop commands are unavailable outside the trusted application shell.");
  return invoke(command, args);
}

let invokeImplementation = invokeThroughTauri;

export function setDesktopInvokeForTests(implementation) {
  invokeImplementation = implementation;
}

function legacyInvestigationStatusWriteDisabled() {
  const error = new Error("Investigation lifecycle changes must use the governed Sequrin case-action API.");
  error.name = "LegacyInvestigationStatusWriteDisabledError";
  error.code = "LEGACY_INVESTIGATION_STATUS_WRITE_DISABLED";
  error.status = 409;
  return error;
}

export const desktopBridge = Object.freeze({
  status: () => invokeImplementation("desktop_status"),
  activate: (activationKey) => invokeImplementation("activate_desktop", { activationKey }),
  login: (username, password) => invokeImplementation("desktop_login", { username, password }),
  logout: () => invokeImplementation("desktop_logout"),
  lock: () => invokeImplementation("lock_desktop"),
  sync: () => invokeImplementation("synchronize_desktop"),
  claimDetails: (claimId) => invokeImplementation("desktop_claim_details", { claimId }),
  investigators: () => invokeImplementation("desktop_investigators"),
  createInvestigation: (claimId, expectedClaimVersion, assignedInvestigator, priority) => invokeImplementation("desktop_create_investigation", {
    claimId,
    expectedClaimVersion,
    assignedInvestigator: assignedInvestigator || null,
    priority,
  }),
  investigationDetails: (investigationId) => invokeImplementation("desktop_investigation_details", { investigationId }),
  updateInvestigation: (investigationId, expectedRecordVersion, changes) => {
    if (changes && Object.hasOwn(changes, "status") && changes.status !== undefined && changes.status !== null) {
      throw legacyInvestigationStatusWriteDisabled();
    }
    return invokeImplementation("desktop_update_investigation", {
      investigationId,
      expectedRecordVersion,
      status: null,
      priority: changes?.priority || null,
      ...(changes && Object.hasOwn(changes, "assignedInvestigator") ? { assignedInvestigator: changes.assignedInvestigator } : {}),
    });
  },
  addInvestigationNote: (investigationId, expectedRecordVersion, text, noteType) => invokeImplementation("desktop_add_investigation_note", {
    investigationId,
    expectedRecordVersion,
    text,
    noteType,
  }),
  uploadInvestigationEvidence: (investigationId, expectedRecordVersion, evidence) => invokeImplementation("desktop_upload_investigation_evidence", {
    investigationId,
    expectedRecordVersion,
    filename: evidence.filename,
    description: evidence.description || null,
    evidenceType: evidence.evidenceType,
    contentType: evidence.contentType,
    contentBase64: evidence.contentBase64,
  }),
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
