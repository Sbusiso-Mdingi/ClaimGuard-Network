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

function normalizedDesktopError(value) {
  if (value instanceof Error && value.code) return value;
  const message = typeof value === "string" ? value : value?.message || "The native desktop request failed.";
  const match = /^([A-Z][A-Z0-9_]{2,127}):(.*)$/s.exec(message);
  const error = value instanceof Error ? value : new Error(match?.[2]?.trim() || message);
  if (match) {
    error.code = match[1];
    error.message = match[2].trim() || match[1];
  }
  return error;
}

async function invokeDesktop(command, args) {
  try {
    return await invokeImplementation(command, args);
  } catch (error) {
    throw normalizedDesktopError(error);
  }
}

const GOVERNED_PAYLOAD_FIELDS = new Set([
  "expectedStateVersion",
  "reasonCode",
  "reasonSummary",
  "evidenceReferences",
  "processCheckReferences",
  "assignedInvestigatorId",
  "reportReference",
  "reportDigest",
  "noEvidenceReason",
  "completionReason",
  "outcomeCode",
  "recordedReasons",
  "identityMatchReviewResult",
  "supportingReportReference",
  "evidenceSetReference",
  "processCheckComplete",
]);

function governedPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("A governed case-action payload is required.");
  }
  const unknown = Object.keys(payload).find((field) => !GOVERNED_PAYLOAD_FIELDS.has(field));
  if (unknown) {
    const error = new Error(`Unsupported governed case-action field: ${unknown}`);
    error.code = "PROHIBITED_CASE_CONTEXT_FIELD";
    throw error;
  }
  return { ...payload };
}

export function createCaseActionIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  const seed = `${Date.now()}-${performance?.now?.() || 0}-${Math.random()}-${Math.random()}`;
  return `case-action-${seed.replace(/[^A-Za-z0-9.-]/g, "-")}`.slice(0, 128);
}

export const desktopBridge = Object.freeze({
  status: () => invokeDesktop("desktop_status"),
  activate: (activationKey) => invokeDesktop("activate_desktop", { activationKey }),
  login: (username, password) => invokeDesktop("desktop_login", { username, password }),
  logout: () => invokeDesktop("desktop_logout"),
  lock: () => invokeDesktop("lock_desktop"),
  sync: () => invokeDesktop("synchronize_desktop"),
  claimDetails: (claimId) => invokeDesktop("desktop_claim_details", { claimId }),
  investigators: () => invokeDesktop("desktop_investigators"),
  createInvestigation: (claimId, expectedClaimVersion, assignedInvestigator, priority) => invokeDesktop("desktop_create_investigation", {
    claimId,
    expectedClaimVersion,
    assignedInvestigator: assignedInvestigator || null,
    priority,
  }),
  investigationDetails: (investigationId) => invokeDesktop("desktop_investigation_details", { investigationId }),
  governedCaseDetails: (investigationId) => invokeDesktop("desktop_governed_case_details", { investigationId }),
  performGovernedCaseAction: (caseId, action, idempotencyKey, payload) => invokeDesktop("desktop_perform_case_action", {
    caseId,
    action,
    idempotencyKey,
    payload: governedPayload(payload),
  }),
  updateInvestigation: (investigationId, expectedRecordVersion, changes) => {
    if (changes && Object.hasOwn(changes, "status") && changes.status !== undefined && changes.status !== null) {
      throw legacyInvestigationStatusWriteDisabled();
    }
    return invokeDesktop("desktop_update_investigation", {
      investigationId,
      expectedRecordVersion,
      status: null,
      priority: changes?.priority || null,
      ...(changes && Object.hasOwn(changes, "assignedInvestigator") ? { assignedInvestigator: changes.assignedInvestigator } : {}),
    });
  },
  addInvestigationNote: (investigationId, expectedRecordVersion, text, noteType) => invokeDesktop("desktop_add_investigation_note", {
    investigationId,
    expectedRecordVersion,
    text,
    noteType,
  }),
  uploadInvestigationEvidence: (investigationId, expectedRecordVersion, evidence) => invokeDesktop("desktop_upload_investigation_evidence", {
    investigationId,
    expectedRecordVersion,
    filename: evidence.filename,
    description: evidence.description || null,
    evidenceType: evidence.evidenceType,
    contentType: evidence.contentType,
    contentBase64: evidence.contentBase64,
  }),
  reset: (confirmation) => invokeDesktop("reset_desktop", { confirmation }),
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
