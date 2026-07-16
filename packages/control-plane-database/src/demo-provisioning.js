import crypto from "node:crypto";

import { hashPassword, passwordParametersRecord, ARGON2ID_VERSION } from "./password.js";

const SCHEME_DEMO_ROLES = Object.freeze([
  ["claims_analyst", "claims.analyst.demo", "Claims Analyst"],
  ["fraud_analyst", "fraud.analyst.demo", "Fraud Analyst"],
  ["investigator", "investigator.demo", "Investigator"],
  ["applications_committee_member", "committee.demo", "Applications Committee Member"],
  ["scheme_administrator", "scheme.admin.demo", "Scheme Administrator"],
]);

function generatedPassword() {
  return crypto.randomBytes(24).toString("base64url");
}

async function activateOrganisation(service, organisation) {
  let current = organisation;
  const nextByStatus = { draft: "provisioning", failed: "provisioning", provisioning: "ready_for_activation", ready_for_activation: "active" };
  while (nextByStatus[current.status]) current = await service.transitionOrganisation(current.organisationId, nextByStatus[current.status]);
  if (current.status !== "active") throw new Error(`Demo organisation ${current.canonicalSlug} cannot be activated from ${current.status}.`);
  return current;
}

async function ensureOrganisation({ repositories, service, displayName, slug, organisationType }) {
  let organisation = await repositories.organisations.getBySlug(slug);
  if (!organisation) {
    organisation = await service.createDraftOrganisation({
      displayName, canonicalSlug: slug, organisationType, deploymentClass: "demo",
    }, { type: "system", id: "demo-provisioner", source: "demo-provisioner" });
  }
  if (organisation.deploymentClass !== "demo" || organisation.organisationType !== organisationType) {
    throw new Error(`Existing organisation ${slug} is not an eligible ${organisationType} demo organisation.`);
  }
  return activateOrganisation(service, organisation);
}

async function ensureRoute({ repositories, service, organisation, routeType, databaseName = null }) {
  const existing = await repositories.routes.getSafeActiveForOrganisation(organisation.organisationId);
  if (existing) {
    if (existing.routeType !== routeType || existing.provisioningStatus !== "active") {
      throw new Error(`Active route for ${organisation.canonicalSlug} is not an eligible ${routeType} route.`);
    }
    return existing;
  }
  return service.registerRoute({
    organisationId: organisation.organisationId,
    routeType,
    logicalDatabaseIdentifier: routeType === "platform_none" ? "platform-control-plane" : "legacy-operational-shared",
    databaseName: routeType === "platform_none" ? null : databaseName,
    secretReference: routeType === "platform_none" ? null : "secret://runtime/MYSQL_URL",
    schemaVersion: routeType === "platform_none" ? null : "8",
    provisioningStatus: "active",
    healthStatus: "unknown",
    activate: true,
  }, { type: "system", id: "demo-provisioner", source: "demo-provisioner" });
}

async function ensureVerifiedMapping({ executor, organisation, tenant, route }) {
  const [rows] = await executor.execute("SELECT * FROM legacy_tenant_mappings WHERE organisation_id = ? LIMIT 1", [organisation.organisationId]);
  const existing = rows?.[0];
  if (existing && (existing.legacy_tenant_id !== tenant.tenantId || existing.legacy_tenant_slug !== tenant.tenantSlug)) {
    throw new Error(`Legacy mapping for ${organisation.canonicalSlug} conflicts with the operational tenant inventory.`);
  }
  if (existing) {
    await executor.execute(
      "UPDATE legacy_tenant_mappings SET migration_status = 'verified', route_id = ?, verified_at = UTC_TIMESTAMP(3) WHERE mapping_id = ?",
      [route.routeId, existing.mapping_id],
    );
    return;
  }
  await executor.execute(
    `INSERT INTO legacy_tenant_mappings
      (mapping_id, legacy_tenant_id, legacy_tenant_slug, organisation_id, migration_status, route_id, verified_at, migration_metadata)
     VALUES (?, ?, ?, ?, 'verified', ?, UTC_TIMESTAMP(3), ?)`,
    [crypto.randomUUID(), tenant.tenantId, tenant.tenantSlug, organisation.organisationId, route.routeId,
      JSON.stringify({ source: "demo-provisioner", shadowOnly: false })],
  );
}

async function ensureAccount({ executor, repositories, service, organisation, roleKey, username, roleLabel, order }) {
  const password = generatedPassword();
  const passwordHash = await hashPassword(password);
  let credential = await repositories.authentication.getInternalCredential({ organisationId: organisation.organisationId, username });
  let userId;
  let membership;
  if (credential) {
    userId = credential.userId;
    await executor.execute(
      "UPDATE users SET status = 'active', disabled_at = NULL, disabled_reason = NULL, authentication_version = authentication_version + 1 WHERE user_id = ?",
      [userId],
    );
    await repositories.authentication.revokeSessionsBy("user", userId, "password_changed");
    await executor.execute(
      `UPDATE credential_identities SET password_hash = ?, password_algorithm = 'argon2id', password_parameters = ?,
       password_version = ?, password_changed_at = UTC_TIMESTAMP(3), failed_attempt_count = 0, locked_until = NULL, status = 'active'
       WHERE credential_id = ?`,
      [passwordHash, JSON.stringify(passwordParametersRecord()), ARGON2ID_VERSION, credential.credentialId],
    );
    membership = await repositories.authentication.getMembership({ userId, organisationId: organisation.organisationId });
    if (!membership) throw new Error(`Credential ${username} has no membership in its organisation.`);
    await executor.execute(
      "UPDATE organisation_memberships SET status = 'active', valid_from = COALESCE(valid_from, UTC_TIMESTAMP(3)), valid_until = NULL WHERE membership_id = ?",
      [membership.membershipId],
    );
  } else {
    const user = await repositories.identity.createUser({
      displayName: `${roleLabel} Demo`, canonicalContact: `${username}.${organisation.canonicalSlug}@demo.invalid`, status: "active",
    });
    userId = user.userId;
    membership = await repositories.identity.createMembership({
      userId, organisationId: organisation.organisationId, status: "active", validFrom: new Date(),
    });
    credential = await repositories.identity.createCredential({
      userId, organisationId: organisation.organisationId, username, status: "active",
      passwordHash, passwordAlgorithm: "argon2id", passwordParameters: passwordParametersRecord(), passwordVersion: ARGON2ID_VERSION,
    });
  }
  await service.assignMembershipRole({
    membershipId: membership.membershipId, roleKey,
    actorRoleKeys: roleKey === "platform_administrator" ? ["platform_administrator"] : [],
  }, { type: "system", id: "demo-provisioner", source: "demo-provisioner" });
  await executor.execute(
    `INSERT INTO demo_account_catalogue
      (catalogue_entry_id, organisation_id, membership_id, display_label, role_label,
       username_display_value, secret_reference, enabled, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE display_label = VALUES(display_label), role_label = VALUES(role_label),
      username_display_value = VALUES(username_display_value), secret_reference = VALUES(secret_reference),
      enabled = 1, display_order = VALUES(display_order)`,
    [crypto.randomUUID(), organisation.organisationId, membership.membershipId, `${roleLabel} — ${organisation.displayName}`,
      roleLabel, username, `secret://ephemeral-demo/${organisation.canonicalSlug}/${username}`, order],
  );
  return { organisation: organisation.canonicalSlug, role: roleKey, username, password };
}

export async function provisionDemoAccounts({ tenants, repositories, service, executor, operationalDatabaseName = null }) {
  if (!Array.isArray(tenants) || tenants.length === 0) throw new Error("At least one operational demo tenant is required.");
  const oneTimeCredentials = [];
  for (const tenant of tenants) {
    const organisation = await ensureOrganisation({
      repositories, service, displayName: tenant.tenantName, slug: tenant.tenantSlug,
      organisationType: "medical_scheme",
    });
    const route = await ensureRoute({ repositories, service, organisation, routeType: "legacy_shared", databaseName: operationalDatabaseName });
    await ensureVerifiedMapping({ executor, organisation, tenant, route });
    for (let index = 0; index < SCHEME_DEMO_ROLES.length; index += 1) {
      const [roleKey, username, roleLabel] = SCHEME_DEMO_ROLES[index];
      oneTimeCredentials.push(await ensureAccount({
        executor, repositories, service, organisation, roleKey, username, roleLabel, order: index + 1,
      }));
    }
  }
  const platform = await ensureOrganisation({
    repositories, service, displayName: "ClaimGuard", slug: "claimguard", organisationType: "platform",
  });
  await ensureRoute({ repositories, service, organisation: platform, routeType: "platform_none" });
  oneTimeCredentials.push(await ensureAccount({
    executor, repositories, service, organisation: platform, roleKey: "platform_administrator",
    username: "platform.admin.demo", roleLabel: "Platform Administrator", order: 1,
  }));
  return { oneTimeCredentials };
}
