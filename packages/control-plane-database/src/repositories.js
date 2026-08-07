import { createConfigurationRepository } from "./configuration-repository.js";
import { createRouteAwareAuthenticationRepository } from "./route-aware-authentication-repository.js";
import { createIdentityRepository } from "./identity-repository.js";
import { createIntegrationCredentialsRepository } from "./integration-credentials-repository.js";
import { createLegacyTenantMappingsRepository } from "./legacy-mapping-repository.js";
import { createModelDeploymentRepository } from "./model-deployment-repository.js";
import { createOrganisationsRepository } from "./organisations-repository.js";
import { createProvisioningRepository } from "./provisioning-repository.js";
import { createReleaseGovernanceRepository } from "./release-governance-repository.js";
import { createDataPlaneRoutesRepository } from "./routes-repository.js";
import { createSecurityRepository } from "./security-repository.js";
import { createDesktopEnrollmentRepository } from "./desktop-enrollment-repository.js";
import { createAccessRepository } from "./access-repository.js";
import { createAccessGovernanceRepository } from "./access-governance-repository.js";
import { createAccessQueryRepository } from "./access-query-repository.js";
import { withControlPlaneTransaction } from "./transaction.js";

export function createControlPlaneRepositories(executor) {
  const accessCommands = createAccessRepository(executor);
  const accessGovernance = createAccessGovernanceRepository(executor);
  const accessQueries = createAccessQueryRepository(executor, {
    ...accessCommands,
    ...accessGovernance,
  });
  const access = Object.freeze({
    ...accessCommands,
    ...accessQueries,
    ...accessGovernance,
  });
  const authenticationBase = createRouteAwareAuthenticationRepository(executor);
  const authentication = Object.freeze({
    ...authenticationBase,
    resolveEffectivePermissions: (input) => access.resolveEffectivePermissions(input),
  });

  return Object.freeze({
    authentication,
    organisations: createOrganisationsRepository(executor),
    identity: createIdentityRepository(executor),
    integrationCredentials: createIntegrationCredentialsRepository(executor),
    routes: createDataPlaneRoutesRepository(executor),
    legacyMappings: createLegacyTenantMappingsRepository(executor),
    modelDeployments: createModelDeploymentRepository(executor),
    provisioning: createProvisioningRepository(executor),
    releaseGovernance: createReleaseGovernanceRepository(executor),
    desktopEnrollment: createDesktopEnrollmentRepository(executor),
    security: createSecurityRepository(executor),
    configuration: createConfigurationRepository(executor),
    access,
    runInTransaction: async (operation) => {
      if (typeof operation !== "function") {
        throw new TypeError("A transaction operation is required.");
      }
      return withControlPlaneTransaction(
        executor,
        (connection) => operation(createControlPlaneRepositories(connection)),
      );
    },
  });
}
