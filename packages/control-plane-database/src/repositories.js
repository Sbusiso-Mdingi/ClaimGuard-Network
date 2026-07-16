import { createConfigurationRepository } from "./configuration-repository.js";
import { createIdentityRepository } from "./identity-repository.js";
import { createLegacyTenantMappingsRepository } from "./legacy-mapping-repository.js";
import { createOrganisationsRepository } from "./organisations-repository.js";
import { createProvisioningRepository } from "./provisioning-repository.js";
import { createDataPlaneRoutesRepository } from "./routes-repository.js";
import { createSecurityRepository } from "./security-repository.js";

export function createControlPlaneRepositories(executor) {
  return Object.freeze({
    organisations: createOrganisationsRepository(executor),
    identity: createIdentityRepository(executor),
    routes: createDataPlaneRoutesRepository(executor),
    legacyMappings: createLegacyTenantMappingsRepository(executor),
    provisioning: createProvisioningRepository(executor),
    security: createSecurityRepository(executor),
    configuration: createConfigurationRepository(executor),
  });
}
