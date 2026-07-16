import crypto from "node:crypto";

import { projectSafeSession } from "./projections.js";
import { executorOr } from "./transaction.js";
import { assertSafeControlPlaneSummary } from "./validation.js";

const AUTH_EVENT_TYPES = new Set([
  "login_success", "login_failure", "login_throttled", "login_locked", "logout", "session_revoked",
  "password_changed", "password_reset_requested", "password_reset_completed", "credential_disabled",
]);

function assertHash(value, fieldName) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${fieldName} must be a SHA-256 hex digest.`);
  return value;
}

export function createSecurityRepository(defaultExecutor) {
  return {
    async storeSessionFoundation(input, { executor } = {}) {
      if (Object.hasOwn(input, "bearerSecret") || Object.hasOwn(input, "rawSessionToken") || Object.hasOwn(input, "sessionToken")) {
        throw new TypeError("Raw session bearer values are not accepted.");
      }
      const sessionId = input.sessionId || crypto.randomUUID();
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO login_sessions
          (session_id, hashed_bearer_secret, signing_key_id, user_id, organisation_id, membership_id,
           issued_at, last_activity_at, idle_expires_at, absolute_expires_at, authorization_version, client_metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, assertHash(input.hashedBearerSecret, "hashedBearerSecret"), input.signingKeyId, input.userId,
          input.organisationId, input.membershipId, input.issuedAt, input.lastActivityAt || input.issuedAt,
          input.idleExpiresAt, input.absoluteExpiresAt, input.authorizationVersion,
          input.clientMetadata ? JSON.stringify(input.clientMetadata) : null],
      );
      return this.getSafeSession(sessionId, { executor });
    },

    async getSafeSession(sessionId, { executor } = {}) {
      const [rows] = await executorOr(defaultExecutor, executor).execute("SELECT * FROM login_sessions WHERE session_id = ? LIMIT 1", [sessionId]);
      return projectSafeSession(rows?.[0]);
    },

    async recordAuthenticationEvent(input, { executor } = {}) {
      assertSafeControlPlaneSummary(input, "authenticationEvent");
      if (!AUTH_EVENT_TYPES.has(input.eventType)) throw new TypeError("Unsupported authentication event type.");
      const eventId = input.eventId || crypto.randomUUID();
      const organisationCandidateHash = input.organisationCandidateHash ? assertHash(input.organisationCandidateHash, "organisationCandidateHash") : null;
      const sourceNetworkHash = input.sourceNetworkHash ? assertHash(input.sourceNetworkHash, "sourceNetworkHash") : null;
      const userAgentHash = input.userAgentHash ? assertHash(input.userAgentHash, "userAgentHash") : null;
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO authentication_events
          (event_id, organisation_id, organisation_candidate_hash, user_id, credential_id, event_type,
           source_network_hash, user_agent_hash, correlation_id, result, failure_category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [eventId, input.organisationId || null, organisationCandidateHash, input.userId || null,
          input.credentialId || null, input.eventType, sourceNetworkHash, userAgentHash,
          input.correlationId || null, input.result, input.failureCategory || null],
      );
      return { eventId, eventType: input.eventType, result: input.result, correlationId: input.correlationId || null };
    },

    async recordPlatformAudit(input, { executor } = {}) {
      assertSafeControlPlaneSummary(input.beforeSummary, "beforeSummary");
      assertSafeControlPlaneSummary(input.afterSummary, "afterSummary");
      const auditEventId = input.auditEventId || crypto.randomUUID();
      await executorOr(defaultExecutor, executor).execute(
        `INSERT INTO platform_audit_events
          (audit_event_id, actor_type, actor_id, organisation_scope_id, action, target_type, target_id,
           before_summary, after_summary, correlation_id, outcome, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [auditEventId, input.actorType, input.actorId || null, input.organisationScopeId || null, input.action,
          input.targetType, input.targetId || null, input.beforeSummary ? JSON.stringify(input.beforeSummary) : null,
          input.afterSummary ? JSON.stringify(input.afterSummary) : null, input.correlationId || null,
          input.outcome || "success", input.source],
      );
      return { auditEventId, correlationId: input.correlationId || null };
    },
  };
}
