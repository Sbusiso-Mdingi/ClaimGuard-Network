import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import crypto from "node:crypto";
import { createOperationalRepositories } from "@claimguard/database";

import { FileReportStorage } from "./report-storage.js";
import { createSessionAuthenticationProvider } from "./middleware/auth-context.js";
import { createAuthenticationMiddleware } from "./middleware/authorization-middleware.js";
import { createTenantContextMiddleware } from "./middleware/tenant-context-middleware.js";
import { createDataPlaneMiddleware } from "./middleware/data-plane-middleware.js";
import { createOperationalDependencyProxy } from "./operational-service-context.js";
import { createSessionCsrfMiddleware } from "./session-security-middleware.js";
import {
  createDesktopDeviceProofMiddleware,
  createDesktopOrganisationEnforcementMiddleware,
} from "./desktop-device-proof.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerPlatformAdminRoutes } from "./routes/platform-admin-routes.js";
import { registerSchemeAdminRoutes } from "./routes/scheme-admin-routes.js";
import { registerAccessRoutes } from "./routes/access-routes.js";
import { registerClaimsRoutes } from "./routes/claims-routes.js";
import { registerDetectionRoutes } from "./routes/detection-routes.js";
import { registerCaseRoutes } from "./routes/case-routes.js";
import { registerInvestigationsRoutes } from "./routes/investigations-routes.js";
import { registerLedgerRoutes } from "./routes/ledger-routes.js";
import { registerRegistryRoutes } from "./routes/registry-routes.js";
import { registerDesktopAdminRoutes, registerDesktopRoutes } from "./routes/desktop-routes.js";
import { registerAssessmentRoutes } from "./routes/assessment-routes.js";
import { createCaseWorkflowService } from "./services/case-workflow-service.js";
import { createClaimIngestionService } from "./services/claim-ingestion-service.js";
import { createFraudConfirmationService } from "./services/fraud-confirmation-service.js";
import { createFraudReversalService } from "./services/fraud-reversal-service.js";
import { createInvestigationService } from "./services/investigation-service.js";
import { logEvent } from "./services/log-event.js";
import { createRegistryService } from "./services/registry-service.js";
import { createReportService } from "./services/report-service.js";
import { backendRouter, backendRouterPath } from "./trpc.js";

function createDomainServices({
  reportStorage,
  ledgerRepository,
  investigationRepository,
  caseWorkflowRepository,
  sharedFraudRegistryRepository,
  fraudWorkflowRepository,
  claimIngestionRepository,
  claimReadRepository,
  generationRepository,
  evidenceStorage,
} = {}) {
  const reportService = createReportService({ reportStorage, ledgerRepository, generationRepository });
  const claimIngestionService = createClaimIngestionService({ claimIngestionRepository, logger: logEvent });
  const investigationService = createInvestigationService({ investigationRepository, evidenceStorage });
  const caseWorkflowService = createCaseWorkflowService({ caseWorkflowRepository });
  const fraudConfirmationService = createFraudConfirmationService({ fraudWorkflowRepository, logger: logEvent });
  const fraudReversalService = createFraudReversalService({ fraudWorkflowRepository, logger: logEvent });
  const registryService = createRegistryService({ sharedFraudRegistryRepository });
  return {
    reportService,
    claimIngestionService,
    claimReadRepository,
    investigationService,
    caseWorkflowService,
    fraudConfirmationService,
    fraudReversalService,
    registryService,
  };
}

export function createBackendApp({
  ledgerRepository = null,
  investigationRepository = null,
  caseWorkflowRepository = null,
  sharedFraudRegistryRepository = null,
  fraudWorkflowRepository = null,
  claimIngestionService = null,
  claimReadRepository = null,
  generationRepository = null,
  tenantRepository = null,
  authenticationProvider = null,
  authenticationConfiguration = Object.freeze({ mode: "session" }),
  authenticationService = null,
  controlPlaneRepositories = null,
  controlPlaneService = null,
  reportStorage = null,
  detectionReportPath = null,
  dataPlaneRuntime = null,
  desktopEnrollmentService = null,
  desktopSyncService = null,
  desktopDeviceProofVerifier = null,
  investigationEvidenceStorage = null,
} = {}) {
  if (authenticationConfiguration.mode !== "session") {
    throw new TypeError("Only session authentication mode is supported.");
  }
  const usesSessionAuthentication = !authenticationProvider;
  if (usesSessionAuthentication && !authenticationService) {
    throw new TypeError("createBackendApp requires authenticationService or an explicit authenticationProvider.");
  }

  const resolvedReportStorage = reportStorage || new FileReportStorage({ reportPath: detectionReportPath });
  const services = createDomainServices({
    reportStorage: resolvedReportStorage,
    ledgerRepository,
    investigationRepository,
    caseWorkflowRepository,
    sharedFraudRegistryRepository,
    fraudWorkflowRepository,
    claimIngestionRepository: claimIngestionService,
    claimReadRepository,
    generationRepository,
    evidenceStorage: investigationEvidenceStorage,
  });

  const dependencies = dataPlaneRuntime ? {
    reportService: createOperationalDependencyProxy("reportService", services.reportService),
    claimIngestionService: createOperationalDependencyProxy("claimIngestionService", services.claimIngestionService),
    claimsReadRepository: createOperationalDependencyProxy("claimsReadRepository", services.claimReadRepository),
    investigationService: createOperationalDependencyProxy("investigationService", services.investigationService),
    caseWorkflowService: createOperationalDependencyProxy("caseWorkflowService", services.caseWorkflowService),
    fraudConfirmationService: createOperationalDependencyProxy("fraudConfirmationService", services.fraudConfirmationService),
    fraudReversalService: createOperationalDependencyProxy("fraudReversalService", services.fraudReversalService),
    registryService: createOperationalDependencyProxy("registryService", services.registryService),
    ledgerRepository: createOperationalDependencyProxy("ledgerRepository", ledgerRepository),
    tenantRepository: createOperationalDependencyProxy("tenantRepository", tenantRepository),
    detectionStrategyRepository: createOperationalDependencyProxy("detectionStrategyRepository", null),
    desktopSyncRepository: createOperationalDependencyProxy("desktopSyncRepository", null),
    generationRepository: createOperationalDependencyProxy("generationRepository", generationRepository),
  } : {
    ...services,
    claimsReadRepository: services.claimReadRepository,
    ledgerRepository,
    tenantRepository,
    detectionStrategyRepository: null,
    desktopSyncRepository: null,
    generationRepository,
  };

  const app = new Hono();
  app.use("*", async (c, next) => {
    const requestStart = Date.now();
    const requestId = c.req.header("x-request-id") || crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    try {
      await next();
    } finally {
      logEvent("info", "http_request", {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - requestStart,
      });
    }
  });

  const resolvedAuthenticationProvider = authenticationProvider || createSessionAuthenticationProvider({
    authenticationService,
    configuration: authenticationConfiguration,
  });
  app.use("*", createAuthenticationMiddleware({ authenticationProvider: resolvedAuthenticationProvider }));
  if (desktopDeviceProofVerifier) app.use("*", createDesktopDeviceProofMiddleware({ verifier: desktopDeviceProofVerifier }));
  if (usesSessionAuthentication) {
    app.use("*", createSessionCsrfMiddleware({ authenticationService, configuration: authenticationConfiguration }));
  }

  if (dataPlaneRuntime) {
    const reportServices = new WeakMap();
    app.use("*", createDataPlaneMiddleware({
      routeResolver: dataPlaneRuntime.routeResolver,
      connectionManager: dataPlaneRuntime.connectionManager,
      logger: dataPlaneRuntime.logger,
      createServiceBundle(dataPlaneContext, pool) {
        const repositories = createOperationalRepositories(dataPlaneContext, pool);
        const servicesForRequest = createDomainServices({
          reportStorage: resolvedReportStorage,
          ledgerRepository: repositories.ledger,
          investigationRepository: repositories.investigations,
          caseWorkflowRepository: repositories.cases,
          sharedFraudRegistryRepository: repositories.registry,
          fraudWorkflowRepository: repositories.fraudWorkflow,
          claimIngestionRepository: repositories.claims,
          claimReadRepository: repositories.claimsRead,
          generationRepository: repositories.claimProcessingOutbox,
          evidenceStorage: investigationEvidenceStorage,
        });
        if (!reportServices.has(pool)) reportServices.set(pool, new Map());
        const tenantReportServices = reportServices.get(pool);
        const reportServiceKey = dataPlaneContext.operationalTenantId;
        if (!tenantReportServices.has(reportServiceKey)) {
          tenantReportServices.set(reportServiceKey, servicesForRequest.reportService);
        }
        return {
          ...servicesForRequest,
          pool,
          claimsReadRepository: repositories.claimsRead,
          reportService: tenantReportServices.get(reportServiceKey),
          ledgerRepository: repositories.ledger,
          tenantRepository: repositories.tenants,
          detectionStrategyRepository: repositories.detectionStrategy,
          desktopSyncRepository: repositories.desktopSync,
          generationRepository: repositories.claimProcessingOutbox,
          operationalRepositories: repositories,
        };
      },
    }));
  }

  app.use("*", createDesktopOrganisationEnforcementMiddleware());
  app.use("*", createTenantContextMiddleware({ tenantRepository: dependencies.tenantRepository }));

  if (usesSessionAuthentication) {
    registerAuthRoutes(app, { authenticationService, configuration: authenticationConfiguration, controlPlaneService });
  }
  registerDesktopRoutes(app, {
    desktopEnrollmentService,
    desktopSyncService,
    authenticationService,
    authenticationConfiguration,
    claimsReadRepository: dependencies.claimsReadRepository,
    desktopSyncRepository: dependencies.desktopSyncRepository,
    investigationService: dependencies.investigationService,
    identityRepository: controlPlaneRepositories?.identity || null,
  });
  if (controlPlaneRepositories && controlPlaneService) {
    registerDesktopAdminRoutes(app, { desktopEnrollmentService, authenticationService });
  }
  registerAdminRoutes(app, {
    reportService: services.reportService,
    dataPlaneRuntime,
    desktopEnrollmentConfigured: Boolean(desktopEnrollmentService),
    detectionStrategyRepository: dependencies.detectionStrategyRepository,
    tenantRepository: dependencies.tenantRepository,
    modelDeploymentRepository: controlPlaneRepositories?.modelDeployments || null,
  });
  if (controlPlaneRepositories && controlPlaneService) {
    registerPlatformAdminRoutes(app, {
      controlPlaneRepositories,
      controlPlaneService,
      authenticationService,
      deploymentClass: authenticationConfiguration.deploymentClass,
    });
    registerSchemeAdminRoutes(app, {
      controlPlaneService,
      claimsReadRepository: dependencies.claimsReadRepository,
      detectionStrategyRepository: dependencies.detectionStrategyRepository,
    });
  }
  if (controlPlaneRepositories) registerAccessRoutes(app, { controlPlaneRepositories });

  registerLedgerRoutes(app, { ledgerRepository: dependencies.ledgerRepository, tenantRepository: dependencies.tenantRepository });
  registerDetectionRoutes(app, { reportService: dependencies.reportService, tenantRepository: dependencies.tenantRepository });
  registerClaimsRoutes(app, {
    claimIngestionService: dependencies.claimIngestionService,
    claimsReadRepository: dependencies.claimsReadRepository,
    tenantRepository: dependencies.tenantRepository,
    logger: logEvent,
  });
  registerCaseRoutes(app, { caseWorkflowService: dependencies.caseWorkflowService, logger: logEvent });
  registerInvestigationsRoutes(app, {
    investigationService: dependencies.investigationService,
    fraudConfirmationService: dependencies.fraudConfirmationService,
    fraudReversalService: dependencies.fraudReversalService,
    tenantRepository: dependencies.tenantRepository,
    identityRepository: controlPlaneRepositories?.identity || null,
    logger: logEvent,
  });
  registerRegistryRoutes(app, { registryService: dependencies.registryService });
  registerAssessmentRoutes(app, { tenantRepository: dependencies.tenantRepository });

  app.all(`${backendRouterPath}/*`, (c) => fetchRequestHandler({
    endpoint: backendRouterPath,
    req: c.req.raw,
    router: backendRouter,
    createContext: async () => ({
      requestId: c.req.header("x-request-id") || null,
      tenantContext: c.get("tenantContext") || null,
    }),
  }));
  return app;
}
