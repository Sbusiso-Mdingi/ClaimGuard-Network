import { createControlPlaneService as createBaseControlPlaneService } from "./control-plane-service.js";
import { ControlPlaneConflictError } from "./errors.js";

export function createSignupCredentialGuardedIdentityRepository(identity) {
  if (!identity || typeof identity.createCredential !== "function") {
    throw new TypeError("An identity repository with createCredential() is required.");
  }

  // Lightweight service tests use partial repository doubles. The production
  // identity repository exposes getInternalCredentialByUsername(), which is
  // used here only as a capability marker before issuing the locked query.
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
