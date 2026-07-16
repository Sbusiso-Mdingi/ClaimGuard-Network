export function projectSafeUser(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    displayName: row.display_name,
    canonicalContact: row.canonical_contact || null,
    status: row.status,
    authenticationVersion: Number(row.authentication_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disabledAt: row.disabled_at || null,
    disabledReason: row.disabled_reason || null,
  };
}

export function projectSafeCredential(row) {
  if (!row) return null;
  return {
    credentialId: row.credential_id,
    userId: row.user_id,
    organisationId: row.organisation_id,
    authenticationProvider: row.authentication_provider,
    normalizedUsername: row.normalized_username,
    status: row.status,
    failedAttemptCount: Number(row.failed_attempt_count || 0),
    lockedUntil: row.locked_until || null,
    passwordConfigured: Boolean(row.password_hash),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function projectSafeRoute(row) {
  if (!row) return null;
  return {
    routeId: row.route_id,
    organisationId: row.organisation_id,
    routeType: row.route_type,
    logicalDatabaseIdentifier: row.logical_database_identifier,
    region: row.region || null,
    routeGeneration: Number(row.route_generation),
    schemaVersion: row.schema_version || null,
    provisioningStatus: row.provisioning_status,
    healthStatus: row.health_status,
    lastHealthCheckAt: row.last_health_check_at || null,
    activeAt: row.active_at || null,
    retiredAt: row.retired_at || null,
  };
}

export function projectSafeSession(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    organisationId: row.organisation_id,
    membershipId: row.membership_id,
    issuedAt: row.issued_at,
    lastActivityAt: row.last_activity_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    revokedAt: row.revoked_at || null,
    revocationReason: row.revocation_reason || null,
    authorizationVersion: Number(row.authorization_version),
  };
}

export function projectSafeDemoCatalogueEntry(row) {
  if (!row || !row.enabled) return null;
  return {
    catalogueEntryId: row.catalogue_entry_id,
    organisationId: row.organisation_id,
    membershipId: row.membership_id,
    displayLabel: row.display_label,
    roleLabel: row.role_label,
    usernameDisplayValue: row.username_display_value,
    displayOrder: Number(row.display_order),
  };
}
