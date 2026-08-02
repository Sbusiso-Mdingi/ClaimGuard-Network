import { CLAIMGUARD_PERMISSIONS, OPERATIONAL_ROUTE_IDS } from "../authorization-policy.js";
import { createEvidenceUploadBodyLimit } from "./evidence-upload-middleware.js";
import {
  createRequireOperationalRouteAuthorizationMiddleware,
  createRequirePermissionMiddleware,
} from "../middleware/authorization-middleware.js";
import { safeSessionResponse, serializeCookie } from "./auth-routes.js";

function desktopError(c, error, fallbackMessage, fallbackCode = "DESKTOP_REQUEST_FAILED") {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return c.json({
    available: false,
    code: error?.code || fallbackCode,
    message: status >= 500 ? fallbackMessage : error?.message || fallbackMessage,
    ...(error?.details && typeof error.details === "object" ? error.details : {}),
  }, status);
}

function actorFromContext(c) {
  const auth = c.get("authContext") || {};
  return {
    type: "user",
    id: auth.user_id || null,
    organisationId: auth.organisation_id || null,
    correlationId: c.get("requestId") || null,
  };
}

function targetOrganisation(c) {
  const auth = c.get("authContext") || {};
  const target = c.req.param("organisationId");
  const platform = auth.roles?.includes("platform_administrator");
  if (!platform && target !== auth.organisation_id) return null;
  return target;
}

function rejectRoutingOverrides(c) {
  const url = new URL(c.req.url);
  const forbiddenQuery = ["organisationId", "organisation_id", "tenantId", "tenant_id", "tenantSlug", "apiOrigin"];
  const forbiddenHeaders = ["x-organisation-id", "x-tenant-id", "x-api-origin"];
  if (forbiddenQuery.some((name) => url.searchParams.has(name)) || forbiddenHeaders.some((name) => c.req.header(name))) {
    return c.json({
      available: false,
      code: "DESKTOP_ROUTING_OVERRIDE_REJECTED",
      message: "Desktop organisation routing is fixed by the enrolled device.",
    }, 400);
  }
  return null;
}

function minimumNecessaryInvestigation(investigation) {
  if (!investigation || typeof investigation !== "object") return investigation;
  const { tenantId: _tenantId, notes = [], evidence = [], ...record } = investigation;
  return {
    ...record,
    notes: notes.map(({ tenantId: _noteTenantId, ...note }) => note),
    evidence: evidence.map(({ tenantId: _evidenceTenantId, ...item }) => item),
  };
}

function desktopExpectedVersion(c, prefix) {
  const raw = String(c.req.header("if-match") || "").replace(/^W\//, "").replace(/^\"|\"$/g, "");
  const match = raw.match(new RegExp(`^${prefix}-(\\d+)$`));
  return match ? Number(match[1]) : null;
}

async function eligibleInvestigators(identityRepository, organisationId) {
  if (!identityRepository?.listUsersByOrganisation) return null;
  const users = await identityRepository.listUsersByOrganisation(organisationId);
  return users.filter((user) => user.userStatus === "active"
    && user.membershipStatus === "active"
    && user.roles?.includes("investigator"));
}

export function registerDesktopRoutes(app, {
  desktopEnrollmentService = null,
  desktopSyncService = null,
  authenticationService = null,
  authenticationConfiguration = null,
  claimsReadRepository = null,
  desktopSyncRepository = null,
  investigationService = null,
  identityRepository = null,
} = {}) {
  const enforceEvidenceBodyLimit = createEvidenceUploadBodyLimit();
  app.post("/desktop/activate", async (c) => {
    if (!desktopEnrollmentService?.activate) {
      return c.json({ available: false, code: "DESKTOP_ACTIVATION_UNAVAILABLE", message: "Desktop activation is not configured." }, 503);
    }
    const payload = await c.req.json().catch(() => ({}));
    const permitted = new Set(["activationKey", "installationId", "devicePublicKey"]);
    if (Object.keys(payload).some((key) => !permitted.has(key))) {
      return c.json({ available: false, code: "DESKTOP_ACTIVATION_INPUT_INVALID", message: "The desktop activation request is invalid." }, 400);
    }
    try {
      const result = await desktopEnrollmentService.activate(payload, c.get("authenticationMetadata") || {});
      return c.json({ available: true, ...result }, 201);
    } catch (error) {
      return desktopError(c, error, "Desktop activation is temporarily unavailable.", "DESKTOP_ACTIVATION_FAILED");
    }
  });

  app.post("/desktop/auth/login", async (c) => {
    if (!authenticationService || !authenticationConfiguration || !desktopEnrollmentService?.renewEnrollment) {
      return c.json({ available: false, code: "DESKTOP_AUTHENTICATION_UNAVAILABLE", message: "Desktop authentication is not configured." }, 503);
    }
    const device = c.get("desktopDevice") || null;
    if (!device) return c.json({ available: false, code: "DEVICE_PROOF_REQUIRED", message: "This desktop device could not be verified." }, 401);
    const payload = await c.req.json().catch(() => ({}));
    if (Object.keys(payload).some((key) => !["username", "password"].includes(key))) {
      return c.json({ available: false, code: "DESKTOP_LOGIN_INPUT_INVALID", message: "Only account credentials are accepted." }, 400);
    }
    let result = null;
    try {
      result = await authenticationService.login({
        organisationSlug: device.organisationSlug,
        username: payload.username,
        password: payload.password,
        requiredOrganisationId: device.organisationId,
      }, c.get("authenticationMetadata") || {});
      const platformIdentity = result.actor?.organisation?.organisationType === "platform"
        || result.actor?.roles?.includes("platform_administrator");
      if (platformIdentity) {
        throw new Error("Platform administration is not a desktop identity.");
      }
      const enrollment = await desktopEnrollmentService.renewEnrollment(device);
      const previous = c.get("resolvedSession") || null;
      if (previous) await authenticationService.logout(previous, c.get("authenticationMetadata") || {});
      const maxAgeSeconds = Math.max(0, (new Date(result.session.absoluteExpiresAt).getTime() - Date.now()) / 1000);
      c.header("Set-Cookie", serializeCookie(authenticationConfiguration, result.bearerSecret, { maxAgeSeconds }));
      return c.json({
        ...safeSessionResponse(result, authenticationConfiguration),
        csrfToken: result.csrfToken,
        licensedOrganisation: {
          organisationId: device.organisationId,
          displayName: device.organisationDisplayName,
        },
        enrollment,
      });
    } catch {
      if (result) {
        await authenticationService.logout(result, c.get("authenticationMetadata") || {}).catch(() => {});
      }
      return c.json({
        available: false,
        code: "DESKTOP_AUTHENTICATION_FAILED",
        message: "The account could not be authorised for the organisation licensed on this device.",
      }, 401);
    }
  });

  app.get("/desktop/auth/session", (c) => {
    const resolved = c.get("resolvedSession") || null;
    const device = c.get("desktopDevice") || null;
    if (!resolved || !device) return c.json({ authenticated: false });
    return c.json({
      ...safeSessionResponse(resolved, authenticationConfiguration),
      licensedOrganisation: {
        organisationId: device.organisationId,
        displayName: device.organisationDisplayName,
      },
    });
  });

  app.post("/desktop/auth/logout", async (c) => {
    const resolved = c.get("resolvedSession") || null;
    if (resolved) await authenticationService?.logout(resolved, c.get("authenticationMetadata") || {});
    if (authenticationConfiguration) {
      c.header("Set-Cookie", serializeCookie(authenticationConfiguration, "", { maxAgeSeconds: 0, expires: new Date(0) }));
    }
    return c.json({ authenticated: false });
  });

  const requireDesktopBootstrap = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DESKTOP_SYNC_BOOTSTRAP,
  });
  const requireDesktopChanges = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DESKTOP_SYNC_CHANGES,
  });
  const requireDesktopClaimDetail = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DESKTOP_CLAIM_DETAIL,
  });
  const requireDesktopInvestigationDetail = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DESKTOP_INVESTIGATION_DETAIL,
  });
  const requireDesktopInvestigationPatch = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DESKTOP_INVESTIGATION_PATCH,
  });
  const requireDesktopInvestigatorsList = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DESKTOP_INVESTIGATORS_LIST,
  });
  const requireDesktopInvestigationCreate = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DESKTOP_INVESTIGATION_CREATE,
  });
  const requireDesktopInvestigationAddNote = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DESKTOP_INVESTIGATION_ADD_NOTE,
  });
  const requireDesktopInvestigationUploadEvidence = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.DESKTOP_INVESTIGATION_UPLOAD_EVIDENCE,
  });

  app.get("/desktop/sync/bootstrap", requireDesktopBootstrap, async (c) => {
    const override = rejectRoutingOverrides(c);
    if (override) return override;
    try {
      const response = await desktopSyncService.bootstrap({
        repository: desktopSyncRepository,
        device: c.get("desktopDevice"),
        authContext: c.get("authContext"),
        dataPlaneContext: c.get("dataPlaneContext"),
        limit: c.req.query("limit"),
        schemaVersion: c.req.header("x-claimguard-desktop-schema") || c.req.query("schemaVersion"),
      });
      const enrollment = await desktopEnrollmentService.renewEnrollment(c.get("desktopDevice"));
      return c.json({ ...response, enrollment });
    } catch (error) {
      return desktopError(c, error, "Desktop synchronization is temporarily unavailable.", "DESKTOP_SYNC_FAILED");
    }
  });

  app.get("/desktop/sync/changes", requireDesktopChanges, async (c) => {
    const override = rejectRoutingOverrides(c);
    if (override) return override;
    try {
      const response = await desktopSyncService.changes({
        repository: desktopSyncRepository,
        device: c.get("desktopDevice"),
        authContext: c.get("authContext"),
        dataPlaneContext: c.get("dataPlaneContext"),
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
        schemaVersion: c.req.header("x-claimguard-desktop-schema") || c.req.query("schemaVersion"),
      });
      const enrollment = await desktopEnrollmentService.renewEnrollment(c.get("desktopDevice"));
      return c.json({ ...response, enrollment });
    } catch (error) {
      return desktopError(c, error, "Desktop synchronization is temporarily unavailable.", "DESKTOP_SYNC_FAILED");
    }
  });

  app.get("/desktop/claims/:claimId", requireDesktopClaimDetail, async (c) => {
    const override = rejectRoutingOverrides(c);
    if (override) return override;
    try {
      const claim = await claimsReadRepository?.getClaimById?.(c.req.param("claimId"));
      if (!claim) return c.json({ available: false, code: "CLAIM_NOT_FOUND", message: "The claim was not found in the licensed organisation." }, 404);
      return c.json({
        available: true,
        claim,
        etag: `W/\"claim-${claim.currentClaimVersion || 1}\"`,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      return desktopError(c, error, "Claim details are temporarily unavailable.", "DESKTOP_CLAIM_FETCH_FAILED");
    }
  });

  app.get("/desktop/investigators", requireDesktopInvestigatorsList, async (c) => {
    const override = rejectRoutingOverrides(c);
    if (override) return override;
    const organisationId = c.get("desktopDevice")?.organisationId || null;
    try {
      const users = await eligibleInvestigators(identityRepository, organisationId);
      if (!users) return c.json({ available: false, code: "DESKTOP_INVESTIGATORS_UNAVAILABLE", message: "Investigator assignment is temporarily unavailable." }, 503);
      return c.json({
        available: true,
        investigators: users.map(({ userId, displayName }) => ({ userId, displayName })),
      });
    } catch (error) {
      return desktopError(c, error, "Investigator assignment is temporarily unavailable.", "DESKTOP_INVESTIGATORS_FETCH_FAILED");
    }
  });

  app.post("/desktop/investigations", requireDesktopInvestigationCreate, async (c) => {
    const override = rejectRoutingOverrides(c);
    if (override) return override;
    if (!investigationService?.createInvestigation) return c.json({ available: false, code: "DESKTOP_INVESTIGATION_UNAVAILABLE", message: "Investigation creation is temporarily unavailable." }, 503);
    const expectedClaimVersion = desktopExpectedVersion(c, "claim");
    if (!expectedClaimVersion) return c.json({ available: false, code: "PRECONDITION_REQUIRED", message: "A current claim record version is required." }, 428);
    const payload = await c.req.json().catch(() => ({}));
    if (Object.keys(payload).some((key) => !["claimId", "assignedInvestigator", "priority"].includes(key))) {
      return c.json({ available: false, code: "DESKTOP_MUTATION_INPUT_INVALID", message: "The investigation creation request is invalid." }, 400);
    }
    try {
      if (payload.assignedInvestigator) {
        const users = await eligibleInvestigators(identityRepository, c.get("desktopDevice")?.organisationId);
        if (!users) return c.json({ available: false, code: "DESKTOP_INVESTIGATORS_UNAVAILABLE", message: "Investigator assignment is temporarily unavailable." }, 503);
        if (!users.some((user) => user.userId === payload.assignedInvestigator)) {
          return c.json({ available: false, code: "INVESTIGATOR_NOT_ELIGIBLE", message: "The selected investigator is not active in this medical scheme." }, 409);
        }
      }
      const investigation = await investigationService.createInvestigation({
        claimId: payload.claimId,
        assignedInvestigator: payload.assignedInvestigator || null,
        assignedBy: c.get("authContext")?.user_id || null,
        priority: payload.priority,
        expectedClaimVersion,
        correlationId: c.get("requestId") || null,
      });
      c.header("ETag", `W/\"investigation-${investigation.recordVersion}\"`);
      return c.json({ available: true, investigation: minimumNecessaryInvestigation(investigation) }, 201);
    } catch (error) {
      const stale = ["stale_claim_version", "stale_record_version"].includes(error?.code);
      return c.json({
        available: false,
        code: stale ? "STALE_RECORD_VERSION" : error?.code || "DESKTOP_MUTATION_FAILED",
        message: stale ? "The claim changed after it was loaded. Refresh before creating an investigation." : error?.message || "The investigation could not be created.",
      }, stale ? 412 : Number.isInteger(error?.status) ? error.status : error?.code?.includes("conflict") || error?.code === "investigation_already_exists" ? 409 : 400);
    }
  });

  app.get("/desktop/investigations/:id", requireDesktopInvestigationDetail, async (c) => {
    const override = rejectRoutingOverrides(c);
    if (override) return override;
    if (!investigationService?.getInvestigationDetails) {
      return c.json({ available: false, code: "DESKTOP_INVESTIGATION_UNAVAILABLE", message: "Investigation details are temporarily unavailable." }, 503);
    }
    try {
      const investigation = await investigationService.getInvestigationDetails(c.req.param("id"));
      if (!investigation) {
        return c.json({ available: false, code: "INVESTIGATION_NOT_FOUND", message: "The investigation was not found in the licensed organisation." }, 404);
      }
      c.header("ETag", `W/\"investigation-${investigation.recordVersion}\"`);
      return c.json({
        available: true,
        investigation: minimumNecessaryInvestigation(investigation),
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      return desktopError(c, error, "Investigation details are temporarily unavailable.", "DESKTOP_INVESTIGATION_FETCH_FAILED");
    }
  });

  app.patch("/desktop/investigations/:id", requireDesktopInvestigationPatch, async (c) => {
    const override = rejectRoutingOverrides(c);
    if (override) return override;
    const expectedRecordVersion = desktopExpectedVersion(c, "investigation");
    if (!expectedRecordVersion) {
      return c.json({ available: false, code: "PRECONDITION_REQUIRED", message: "A current investigation version is required." }, 428);
    }
    const payload = await c.req.json().catch(() => ({}));
    if (Object.keys(payload).some((key) => !["status", "priority", "assignedInvestigator"].includes(key))) {
      return c.json({ available: false, code: "DESKTOP_MUTATION_INPUT_INVALID", message: "The investigation update is invalid." }, 400);
    }
    try {
      if (Object.hasOwn(payload, "assignedInvestigator") && payload.assignedInvestigator) {
        const users = await eligibleInvestigators(identityRepository, c.get("desktopDevice")?.organisationId);
        if (!users) return c.json({ available: false, code: "DESKTOP_INVESTIGATORS_UNAVAILABLE", message: "Investigator assignment is temporarily unavailable." }, 503);
        if (!users.some((user) => user.userId === payload.assignedInvestigator)) {
          return c.json({ available: false, code: "INVESTIGATOR_NOT_ELIGIBLE", message: "The selected investigator is not active in this medical scheme." }, 409);
        }
      }
      const investigation = await investigationService.updateInvestigation({
        investigationId: c.req.param("id"),
        status: payload.status,
        priority: payload.priority,
        assignedInvestigator: Object.hasOwn(payload, "assignedInvestigator") ? payload.assignedInvestigator : undefined,
        expectedRecordVersion,
        actorId: c.get("authContext")?.user_id || null,
        correlationId: c.get("requestId") || null,
      });
      c.header("ETag", `W/\"investigation-${investigation.recordVersion}\"`);
      return c.json({ available: true, investigation: minimumNecessaryInvestigation(investigation) });
    } catch (error) {
      const stale = error?.code === "stale_record_version";
      return c.json({
        available: false,
        code: stale ? "STALE_RECORD_VERSION" : error?.code || "DESKTOP_MUTATION_FAILED",
        message: stale
          ? "The investigation changed after it was loaded. Authoritative state must be refreshed."
          : "The investigation could not be updated.",
      }, stale ? 412 : Number.isInteger(error?.status) ? error.status : 400);
    }
  });

  app.post("/desktop/investigations/:id/notes", requireDesktopInvestigationAddNote, async (c) => {
    const override = rejectRoutingOverrides(c);
    if (override) return override;
    if (!investigationService?.addNote) return c.json({ available: false, code: "DESKTOP_INVESTIGATION_UNAVAILABLE", message: "Investigation notes are temporarily unavailable." }, 503);
    const expectedRecordVersion = desktopExpectedVersion(c, "investigation");
    if (!expectedRecordVersion) return c.json({ available: false, code: "PRECONDITION_REQUIRED", message: "A current investigation record version is required." }, 428);
    const payload = await c.req.json().catch(() => ({}));
    if (Object.keys(payload).some((key) => !["text", "noteType"].includes(key))) {
      return c.json({ available: false, code: "DESKTOP_MUTATION_INPUT_INVALID", message: "The investigation note is invalid." }, 400);
    }
    try {
      const result = await investigationService.addNote({
        investigationId: c.req.param("id"),
        author: c.get("authContext")?.user_id || null,
        text: payload.text,
        noteType: payload.noteType,
        expectedRecordVersion,
        correlationId: c.get("requestId") || null,
      });
      c.header("ETag", `W/\"investigation-${result.investigation.recordVersion}\"`);
      return c.json({ available: true, note: result.note, investigation: minimumNecessaryInvestigation(result.investigation) }, 201);
    } catch (error) {
      const stale = error?.code === "stale_record_version";
      return c.json({ available: false, code: stale ? "STALE_RECORD_VERSION" : error?.code || "DESKTOP_MUTATION_FAILED", message: stale ? "The investigation changed after it was loaded. Refresh before adding the note." : error?.message || "The note could not be added." }, stale ? 412 : Number.isInteger(error?.status) ? error.status : 400);
    }
  });

  app.post("/desktop/investigations/:id/evidence", enforceEvidenceBodyLimit, requireDesktopInvestigationUploadEvidence, async (c) => {
    const override = rejectRoutingOverrides(c);
    if (override) return override;
    if (!investigationService?.uploadEvidence) return c.json({ available: false, code: "DESKTOP_INVESTIGATION_UNAVAILABLE", message: "Evidence upload is temporarily unavailable." }, 503);
    const expectedRecordVersion = desktopExpectedVersion(c, "investigation");
    if (!expectedRecordVersion) return c.json({ available: false, code: "PRECONDITION_REQUIRED", message: "A current investigation record version is required." }, 428);
    const payload = await c.req.json().catch(() => ({}));
    if (Object.keys(payload).some((key) => !["filename", "description", "evidenceType", "contentType", "contentBase64"].includes(key))) {
      return c.json({ available: false, code: "DESKTOP_MUTATION_INPUT_INVALID", message: "The evidence upload is invalid." }, 400);
    }
    try {
      const result = await investigationService.uploadEvidence({
        tenantId: c.get("tenantContext")?.tenant_id || null,
        investigationId: c.req.param("id"),
        filename: payload.filename,
        description: payload.description,
        uploadedBy: c.get("authContext")?.user_id || null,
        evidenceType: payload.evidenceType,
        contentType: payload.contentType,
        contentBase64: payload.contentBase64,
        expectedRecordVersion,
        correlationId: c.get("requestId") || null,
      });
      c.header("ETag", `W/\"investigation-${result.investigation.recordVersion}\"`);
      return c.json({ available: true, evidence: result.evidence, investigation: minimumNecessaryInvestigation(result.investigation) }, 201);
    } catch (error) {
      const stale = error?.code === "stale_record_version";
      return c.json({ available: false, code: stale ? "STALE_RECORD_VERSION" : error?.code || "DESKTOP_MUTATION_FAILED", message: stale ? "The investigation changed after it was loaded. Refresh before uploading evidence." : error?.message || "The evidence could not be uploaded." }, stale ? 412 : Number.isInteger(error?.status) ? error.status : 400);
    }
  });
}

export function registerDesktopAdminRoutes(app, {
  desktopEnrollmentService = null,
  authenticationService = null,
} = {}) {
  const requireDesktopManage = createRequirePermissionMiddleware({
    permission: CLAIMGUARD_PERMISSIONS.DESKTOP_DEVICES_MANAGE,
  });

  app.get("/admin/desktop/organisations/:organisationId", requireDesktopManage, async (c) => {
    if (!desktopEnrollmentService?.getAdminSnapshot) {
      return c.json({ available: false, code: "DESKTOP_ADMINISTRATION_UNAVAILABLE", message: "Desktop device administration is not configured." }, 503);
    }
    const organisationId = targetOrganisation(c);
    if (!organisationId) return c.json({ available: false, code: "FORBIDDEN", message: "You do not have permission to manage this organisation." }, 403);
    try {
      return c.json({ available: true, ...(await desktopEnrollmentService.getAdminSnapshot(organisationId)) });
    } catch (error) {
      return desktopError(c, error, "Desktop device administration is temporarily unavailable.");
    }
  });

  app.post("/admin/desktop/organisations/:organisationId/activation-keys", requireDesktopManage, async (c) => {
    if (!desktopEnrollmentService?.issueActivationKey || !authenticationService?.reauthenticate) {
      return c.json({ available: false, code: "DESKTOP_ADMINISTRATION_UNAVAILABLE", message: "Desktop device administration is not configured." }, 503);
    }
    const organisationId = targetOrganisation(c);
    if (!organisationId) return c.json({ available: false, code: "FORBIDDEN", message: "You do not have permission to manage this organisation." }, 403);
    const payload = await c.req.json().catch(() => ({}));
    if (payload.confirmation !== "ISSUE DESKTOP KEY") {
      return c.json({ available: false, code: "DESKTOP_CONFIRMATION_MISMATCH", message: "The activation-key confirmation did not match." }, 400);
    }
    try {
      await authenticationService.reauthenticate(c.get("resolvedSession"), payload.password, c.get("authenticationMetadata") || {});
      const result = await desktopEnrollmentService.issueActivationKey({
        organisationId,
        expiresInHours: payload.expiresInHours,
        maximumUses: payload.maximumUses,
      }, actorFromContext(c));
      return c.json({ available: true, activationKey: result, displayedOnce: true }, 201);
    } catch (error) {
      return desktopError(c, error, "The activation key could not be issued.");
    }
  });

  app.post("/admin/desktop/organisations/:organisationId/activation-keys/:activationKeyId/revoke", requireDesktopManage, async (c) => {
    if (!desktopEnrollmentService?.revokeActivationKey || !authenticationService?.reauthenticate) {
      return c.json({ available: false, code: "DESKTOP_ADMINISTRATION_UNAVAILABLE", message: "Desktop device administration is not configured." }, 503);
    }
    const organisationId = targetOrganisation(c);
    if (!organisationId) return c.json({ available: false, code: "FORBIDDEN", message: "You do not have permission to manage this organisation." }, 403);
    const payload = await c.req.json().catch(() => ({}));
    const activationKeyId = c.req.param("activationKeyId");
    if (payload.confirmation !== `REVOKE KEY ${activationKeyId}`) {
      return c.json({ available: false, code: "DESKTOP_CONFIRMATION_MISMATCH", message: "The activation-key revocation confirmation did not match." }, 400);
    }
    try {
      await authenticationService.reauthenticate(c.get("resolvedSession"), payload.password, c.get("authenticationMetadata") || {});
      return c.json({ available: true, ...(await desktopEnrollmentService.revokeActivationKey({ organisationId, activationKeyId, reason: payload.reason }, actorFromContext(c))) });
    } catch (error) {
      return desktopError(c, error, "The activation key could not be revoked.");
    }
  });

  app.post("/admin/desktop/organisations/:organisationId/devices/:deviceEnrollmentId/revoke", requireDesktopManage, async (c) => {
    if (!desktopEnrollmentService?.revokeDevice || !authenticationService?.reauthenticate) {
      return c.json({ available: false, code: "DESKTOP_ADMINISTRATION_UNAVAILABLE", message: "Desktop device administration is not configured." }, 503);
    }
    const organisationId = targetOrganisation(c);
    if (!organisationId) return c.json({ available: false, code: "FORBIDDEN", message: "You do not have permission to manage this organisation." }, 403);
    const payload = await c.req.json().catch(() => ({}));
    const deviceEnrollmentId = c.req.param("deviceEnrollmentId");
    if (payload.confirmation !== `REVOKE DEVICE ${deviceEnrollmentId}`) {
      return c.json({ available: false, code: "DESKTOP_CONFIRMATION_MISMATCH", message: "The device revocation confirmation did not match." }, 400);
    }
    try {
      await authenticationService.reauthenticate(c.get("resolvedSession"), payload.password, c.get("authenticationMetadata") || {});
      return c.json({ available: true, ...(await desktopEnrollmentService.revokeDevice({ organisationId, deviceEnrollmentId, reason: payload.reason }, actorFromContext(c))) });
    } catch (error) {
      return desktopError(c, error, "The desktop device could not be revoked.");
    }
  });
}
