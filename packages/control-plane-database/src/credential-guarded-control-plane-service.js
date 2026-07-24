import { createControlPlaneService as createBaseControlPlaneService } from "./control-plane-service.js";
import { ControlPlaneConflictError } from "./errors.js";

export function createSignupCredentialGuardedIdentityRepository(identity) {
  if (!identity || typeof identity !== "object") {
    throw new TypeError("An identity repository is required.");
  }

  // Many control-plane service tests intentionally use partial repository
  // doubles for operations that never create credentials. Leave those
  // fixtures unchanged instead of making unrelated service construction fail.
  if (typeof identity.createCredential !== "function") {
    return identity;
  }

  // The production identity repository exposes
  // getInternalCredentialByUsername(). Lightweight credential-specific tests
  // may omit it, so use it only as a capability marker for the production
  // repository before installing the transaction-scoped guard.
  if (typeof identity.getInternalCredentialByUsername !== "function") {
    return identity;
  }

  return {
    ...identity,

    async createCredential(input, options = {}) {
      const authenticationProvider = String(
        input?.authenticationProvider || "local_password",
      ).trim();

      if (authenticationProvider === "local_password") {
        const userId = String(input?.userId || "").trim();
        const organisationId = String(input?.organisationId || "").trim();
        const executor = options?.executor;

        if (!userId || !organisationId) {
          throw new TypeError(
            "userId and organisationId are required for local credential creation.",
          );
        }

        if (!executor || typeof executor.execute !== "function") {
          throw new TypeError(
            "A transaction executor is required for guarded local credential creation.",
          );
        }

        const [rows] = await executor.execute(
          `SELECT credential_id
           FROM credential_identities
           WHERE user_id = ?
             AND organisation_id = ?
             AND authentication_provider = 'local_password'
           LIMIT 1
           FOR UPDATE`,
          [userId, organisationId],
        );

        if (rows?.[0]) {
          throw new ControlPlaneConflictError(
            "This administrator already has a local-password credential.",
            "ADMIN_CREDENTIAL_ALREADY_CONFIGURED",
          );
        }
      }

      return identity.createCredential(input, options);
    },
  };
}

export function createControlPlaneService({ pool, repositories }) {
  const service = createBaseControlPlaneService({ pool, repositories });

  const signupRepositories = {
    ...repositories,
    identity: createSignupCredentialGuardedIdentityRepository(
      repositories.identity,
    ),
  };

  const guardedSignupService = createBaseControlPlaneService({
    pool,
    repositories: signupRepositories,
  });

  return {
    ...service,
    signupWithInvitation: guardedSignupService.signupWithInvitation,
  };
}
