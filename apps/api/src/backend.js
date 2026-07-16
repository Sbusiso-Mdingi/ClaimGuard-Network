import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import crypto from "node:crypto";

import { FileReportStorage } from "./report-storage.js";
import { createAuthenticationMiddleware } from "./middleware/authorization-middleware.js";
import { createTenantContextMiddleware } from "./middleware/tenant-context-middleware.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerClaimsRoutes } from "./routes/claims-routes.js";
import { registerDetectionRoutes } from "./routes/detection-routes.js";
import { registerInvestigationsRoutes } from "./routes/investigations-routes.js";
import { registerLedgerRoutes } from "./routes/ledger-routes.js";
import { registerRegistryRoutes } from "./routes/registry-routes.js";
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
  sharedFraudRegistryRepository,
  fraudWorkflowRepository,
  claimIngestionRepository,
  detectionAnalyzeProxyUrl,
} = {}) {
  const reportService = createReportService({
    reportStorage,
    ledgerRepository,
    detectionAnalyzeProxyUrl,
  });

  const claimIngestionService = createClaimIngestionService({
    claimIngestionRepository,
    logger: logEvent,
  });

  const investigationService = createInvestigationService({
    investigationRepository,
  });

  const fraudConfirmationService = createFraudConfirmationService({
    fraudWorkflowRepository,
    logger: logEvent,
  });

  const fraudReversalService = createFraudReversalService({
    fraudWorkflowRepository,
    logger: logEvent,
  });

  const registryService = createRegistryService({
    sharedFraudRegistryRepository,
  });

  return {
    reportService,
    claimIngestionService,
    investigationService,
    fraudConfirmationService,
    fraudReversalService,
    registryService,
  };
}

export function createBackendApp({
  ledgerRepository = null,
  investigationRepository = null,
  sharedFraudRegistryRepository = null,
  fraudWorkflowRepository = null,
  claimIngestionService = null,
  tenantRepository = null,
  authenticationProvider = null,
  reportStorage = null,
  detectionAnalyzeProxyUrl = null,
  detectionReportPath = null,
} = {}) {
  const resolvedReportStorage =
    reportStorage ||
    new FileReportStorage({
      reportPath: detectionReportPath,
    });

  const services = createDomainServices({
    reportStorage: resolvedReportStorage,
    ledgerRepository,
    investigationRepository,
    sharedFraudRegistryRepository,
    fraudWorkflowRepository,
    claimIngestionRepository: claimIngestionService,
    detectionAnalyzeProxyUrl,
  });

  const app = new Hono();

  app.use(
    "*",
    createAuthenticationMiddleware({
      authenticationProvider: authenticationProvider || undefined,
    }),
  );

  app.use(
    "*",
    createTenantContextMiddleware({
      tenantRepository,
    }),
  );

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

  registerAdminRoutes(app, {
    reportService: services.reportService,
  });

  registerLedgerRoutes(app, {
    ledgerRepository,
    tenantRepository,
  });

  registerDetectionRoutes(app, {
    reportService: services.reportService,
    tenantRepository,
  });

  registerClaimsRoutes(app, {
    claimIngestionService: services.claimIngestionService,
    tenantRepository,
    logger: logEvent,
  });

  registerInvestigationsRoutes(app, {
    investigationService: services.investigationService,
    fraudConfirmationService: services.fraudConfirmationService,
    fraudReversalService: services.fraudReversalService,
    tenantRepository,
    logger: logEvent,
  });

  registerRegistryRoutes(app, {
    registryService: services.registryService,
  });

  app.all(`${backendRouterPath}/*`, (c) => {
    return fetchRequestHandler({
      endpoint: backendRouterPath,
      req: c.req.raw,
      router: backendRouter,
      createContext: async () => ({
        requestId: c.req.header("x-request-id") || null,
        tenantContext: c.get("tenantContext") || null,
      }),
    });
  });

  return app;
}
