import { ControlPlaneConflictError, ControlPlaneNotFoundError, ControlPlaneValidationError } from "./errors.js";
import { withControlPlaneTransaction } from "./transaction.js";

const ORGANISATION_TRANSITIONS = Object.freeze({
  draft: ["provisioning", "failed", "archived"],
  provisioning: ["ready_for_activation", "failed"],
  ready_for_activation: ["active", "failed"],
  active: ["suspended", "archived"],
  suspended: ["active", "archived"],
  failed: ["provisioning", "archived"],
  archived: [],
});

const PROVISIONING_TRANSITIONS = Object.freeze({
  pending: ["running", "failed", "quarantined"],
  running: ["completed", "failed", "compensating", "quarantined"],
  failed: ["running", "compensating", "quarantined"],
  compensating: ["compensated", "failed", "quarantined"],
  completed: [],
  compensated: [],
  quarantined: ["compensating"],
});

export function createControlPlaneService({ pool, repositories }) {
  if (!pool || !repositories) throw new TypeError("Control-plane pool and repositories are required.");

  async function audit(executor, input) {
    return repositories.security.recordPlatformAudit(input, { executor });
  }

  return {
    async reserveSlug(input, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const slug = await repositories.organisations.reserveSlug(input.slug, {
          organisationId: input.organisationId || null,
          slugType: input.slugType || "reserved",
          redirectToSlug: input.redirectToSlug || null,
          executor,
        });
        await audit(executor, {
          actorType: actor?.type || "system", actorId: actor?.id || null,
          organisationScopeId: input.organisationId || null, action: "organisation_slug.reserve",
          targetType: "organisation_slug", targetId: slug,
          afterSummary: { slugType: input.slugType || "reserved", redirectToSlug: input.redirectToSlug || null },
          correlationId: actor?.correlationId || null, outcome: "success", source: actor?.source || "control-plane-service",
        });
        return slug;
      });
    },

    async createDraftOrganisation(input, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const organisation = await repositories.organisations.createDraft(input, { executor });
        await audit(executor, {
          actorType: actor?.type || "system", actorId: actor?.id || null,
          organisationScopeId: organisation.organisationId, action: "organisation.create_draft",
          targetType: "organisation", targetId: organisation.organisationId,
          afterSummary: { displayName: organisation.displayName, canonicalSlug: organisation.canonicalSlug, status: organisation.status },
          correlationId: actor?.correlationId || null, outcome: "success", source: actor?.source || "control-plane-service",
        });
        return organisation;
      });
    },

    async transitionOrganisation(organisationId, toStatus, { suspensionReason = null, actor } = {}) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const current = await repositories.organisations.getById(organisationId, { executor });
        if (!current) throw new ControlPlaneNotFoundError("Organisation was not found.", "ORGANISATION_NOT_FOUND");
        if (!(ORGANISATION_TRANSITIONS[current.status] || []).includes(toStatus)) {
          throw new ControlPlaneConflictError(`Organisation cannot transition from ${current.status} to ${toStatus}.`, "INVALID_ORGANISATION_TRANSITION");
        }
        const updated = await repositories.organisations.updateStatus(organisationId, toStatus, { suspensionReason, executor });
        await audit(executor, {
          actorType: actor?.type || "system", actorId: actor?.id || null, organisationScopeId: organisationId,
          action: "organisation.transition", targetType: "organisation", targetId: organisationId,
          beforeSummary: { status: current.status }, afterSummary: { status: updated.status },
          correlationId: actor?.correlationId || null, outcome: "success", source: actor?.source || "control-plane-service",
        });
        return updated;
      });
    },

    async createMembership(input, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const membership = await repositories.identity.createMembership(input, { executor });
        await audit(executor, {
          actorType: actor?.type || "system", actorId: actor?.id || null, organisationScopeId: input.organisationId,
          action: "membership.create", targetType: "membership", targetId: membership.membershipId,
          afterSummary: { userId: input.userId, status: membership.status }, correlationId: actor?.correlationId || null,
          outcome: "success", source: actor?.source || "control-plane-service",
        });
        return membership;
      });
    },

    async assignMembershipRole({ membershipId, roleKey, assignedBy = null, actorRoleKeys = [] }, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const membership = await repositories.identity.getMembership(membershipId, { executor });
        if (!membership) throw new ControlPlaneNotFoundError("Membership was not found.", "MEMBERSHIP_NOT_FOUND");
        if (membership.status !== "active") {
          throw new ControlPlaneConflictError("Only an active membership can receive active role authority.", "INACTIVE_MEMBERSHIP_ROLE_ASSIGNMENT");
        }
        const organisation = await repositories.organisations.getById(membership.organisationId, { executor });
        const role = await repositories.identity.resolveRole(roleKey, { executor });
        if (!role) throw new ControlPlaneNotFoundError("Role was not found.", "ROLE_NOT_FOUND");
        if (role.organisationScope !== organisation.organisationType) {
          throw new ControlPlaneValidationError("Role scope does not match the organisation type.", "ROLE_SCOPE_MISMATCH");
        }
        if (role.roleKey === "platform_administrator" && !actorRoleKeys.includes("platform_administrator")) {
          throw new ControlPlaneValidationError("Only a platform administrator may assign platform administrator.", "PLATFORM_ROLE_ASSIGNMENT_FORBIDDEN");
        }
        const assignment = await repositories.identity.assignRole({ membershipId, roleId: role.roleId, assignedBy }, { executor });
        await audit(executor, {
          actorType: actor?.type || "user", actorId: actor?.id || assignedBy, organisationScopeId: membership.organisationId,
          action: "membership.role_assign", targetType: "membership", targetId: membershipId,
          afterSummary: { roleKey: role.roleKey }, correlationId: actor?.correlationId || null,
          outcome: "success", source: actor?.source || "control-plane-service",
        });
        return assignment;
      });
    },

    async registerRoute(input, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const organisation = await repositories.organisations.getById(input.organisationId, { executor });
        if (!organisation) throw new ControlPlaneNotFoundError("Organisation was not found.", "ORGANISATION_NOT_FOUND");
        if (organisation.organisationType === "platform" && input.routeType !== "platform_none") {
          throw new ControlPlaneValidationError("A platform organisation must use platform_none routing.", "PLATFORM_ROUTE_REQUIRED");
        }
        if (organisation.organisationType === "medical_scheme" && input.routeType === "platform_none") {
          throw new ControlPlaneValidationError("A medical-scheme organisation requires an operational route type.", "MEDICAL_SCHEME_ROUTE_REQUIRED");
        }
        const route = await repositories.routes.register(input, { executor });
        await audit(executor, {
          actorType: actor?.type || "system", actorId: actor?.id || null, organisationScopeId: input.organisationId,
          action: "data_plane_route.register", targetType: "data_plane_route", targetId: route.routeId,
          afterSummary: { routeType: route.routeType, generation: route.routeGeneration, provisioningStatus: route.provisioningStatus },
          correlationId: actor?.correlationId || null, outcome: "success", source: actor?.source || "control-plane-service",
        });
        return route;
      });
    },

    async mapLegacyTenant(input, actor) {
      return withControlPlaneTransaction(pool, async (executor) => {
        const organisation = await repositories.organisations.getById(input.organisationId, { executor });
        if (!organisation) throw new ControlPlaneNotFoundError("Organisation was not found.", "ORGANISATION_NOT_FOUND");
        const mapping = await repositories.legacyMappings.create(input, { executor });
        await audit(executor, {
          actorType: actor?.type || "system", actorId: actor?.id || null, organisationScopeId: input.organisationId,
          action: "legacy_tenant.map", targetType: "legacy_tenant_mapping", targetId: mapping.mappingId,
          afterSummary: { legacyTenantId: mapping.legacyTenantId, legacyTenantSlug: mapping.legacyTenantSlug, status: mapping.migrationStatus },
          correlationId: actor?.correlationId || null, outcome: "success", source: actor?.source || "legacy-inventory",
        });
        return mapping;
      });
    },

    async transitionProvisioningOperation(operationId, toStatus, { error = null } = {}) {
      const operation = await repositories.provisioning.getOperation(operationId);
      if (!operation) throw new ControlPlaneNotFoundError("Provisioning operation was not found.", "PROVISIONING_OPERATION_NOT_FOUND");
      const allowed = PROVISIONING_TRANSITIONS[operation.status] || [];
      if (!allowed.includes(toStatus)) {
        throw new ControlPlaneConflictError(`Provisioning cannot transition from ${operation.status} to ${toStatus}.`, "INVALID_PROVISIONING_TRANSITION");
      }
      return repositories.provisioning.transitionOperation(operationId, [operation.status], toStatus, { error });
    },
  };
}
