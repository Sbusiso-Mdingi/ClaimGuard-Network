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
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerPlatformAdminRoutes } from "./routes/platform-admin-routes.js";
import { registerSchemeAdminRoutes } from "./routes/scheme-admin-routes.js";
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
  claimReadRepository,
  generationRepository,
} = {}) {
  const reportService = createReportService({
    reportStorage,
    ledgerRepository,
    generationRepository,
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
    claimReadRepository,
    investigationService,
    fraudConfirmationService,
    fraudReversalService,
    registryService,
  };
}

function normalizePaging({ page = 1, pageSize = 25, maxPageSize = 100 } = {}) {
  const parsedPage = Number.parseInt(String(page ?? ""), 10);
  const parsedPageSize = Number.parseInt(String(pageSize ?? ""), 10);
  const safePage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const requestedPageSize = Number.isInteger(parsedPageSize) && parsedPageSize > 0 ? parsedPageSize : 25;
  const safePageSize = Math.min(requestedPageSize, maxPageSize);
  return {
    page: safePage,
    pageSize: safePageSize,
    requestedPageSize,
    maxPageSize,
    offset: (safePage - 1) * safePageSize,
  };
}

function mapClaimRowForApi(row) {
  if (!row) return null;
  return {
    claimId: row.claim_id,
    schemeId: row.scheme_id,
    memberId: row.member_id,
    providerId: row.provider_id,
    serviceDate: row.service_date,
    billedAmount: Number(row.amount),
    billingCode: row.billing_code,
    submittedAt: row.created_at,
    updatedAt: row.updated_at,
    status: "SUBMITTED",
    riskScore: null,
    riskLevel: null,
    investigation: null,
  };
}

function createApiClaimsReadRepository(pool, dataPlaneContext) {
  const tenantId = dataPlaneContext?.operationalTenantId || null;
  return Object.freeze({
    async listClaims({ page = 1, pageSize = 25 } = {}) {
      if (!tenantId) {
        const error = new Error("Operational tenant context is required for claims read.");
        error.code = "DATA_PLANE_TENANT_MISMATCH";
        error.status = 403;
        throw error;
      }
      const paging = normalizePaging({ page, pageSize });
      const [countRows] = await pool.execute("SELECT COUNT(*) AS total FROM claims WHERE tenant_id = ?", [tenantId]);
      const total = Number(countRows?.[0]?.total || 0);
      const [rows] = await pool.execute(
        `
          SELECT claim_id, scheme_id, member_id, provider_id, service_date, amount, billing_code, created_at, updated_at
          FROM claims
          WHERE tenant_id = ?
          ORDER BY updated_at DESC, claim_id ASC
          LIMIT ${paging.pageSize} OFFSET ${paging.offset}
        `,
        [tenantId],
      );
      const claims = rows.map(mapClaimRowForApi);
      return {
        claims,
        pagination: {
          page: paging.page,
          pageSize: paging.pageSize,
          requestedPageSize: paging.requestedPageSize,
          maxPageSize: paging.maxPageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / paging.pageSize)),
          hasNextPage: paging.offset + claims.length < total,
        },
      };
    },
    async getClaimById(claimId) {
      if (!tenantId) {
        const error = new Error("Operational tenant context is required for claims read.");
        error.code = "DATA_PLANE_TENANT_MISMATCH";
        error.status = 403;
        throw error;
      }
      const normalized = String(claimId || "").trim();
      if (!normalized) return null;
      const [rows] = await pool.execute(
        `
          SELECT claim_id, scheme_id, member_id, provider_id, service_date, amount, billing_code, created_at, updated_at
          FROM claims
          WHERE tenant_id = ? AND claim_id = ?
          LIMIT 1
        `,
        [tenantId, normalized],
      );
      return mapClaimRowForApi(rows?.[0] || null);
    },
  });
}

export function createBackendApp({
  ledgerRepository = null,
  investigationRepository = null,
  sharedFraudRegistryRepository = null,
  fraudWorkflowRepository = null,
  claimIngestionService = null,
  claimReadRepository = null,
  generationRepository = null,
  tenantRepository = null,
  authenticationProvider = null,
  authenticationConfiguration = Object.freeze({ mode: "demo_headers" }),
  authenticationService = null,
  controlPlaneConfigurationRepository = null,
  controlPlaneRepositories = null,
  controlPlaneService = null,
  reportStorage = null,
  detectionReportPath = null,
  dataPlaneRuntime = null,
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
    claimReadRepository,
    generationRepository,
  });

  const dependencies = dataPlaneRuntime ? {
    reportService: createOperationalDependencyProxy("reportService", services.reportService),
    claimIngestionService: createOperationalDependencyProxy("claimIngestionService", services.claimIngestionService),
    claimsReadRepository: createOperationalDependencyProxy("claimsReadRepository", services.claimReadRepository),
    investigationService: createOperationalDependencyProxy("investigationService", services.investigationService),
    fraudConfirmationService: createOperationalDependencyProxy("fraudConfirmationService", services.fraudConfirmationService),
    fraudReversalService: createOperationalDependencyProxy("fraudReversalService", services.fraudReversalService),
    registryService: createOperationalDependencyProxy("registryService", services.registryService),
    ledgerRepository: createOperationalDependencyProxy("ledgerRepository", ledgerRepository),
    tenantRepository: createOperationalDependencyProxy("tenantRepository", tenantRepository),
    detectionStrategyRepository: createOperationalDependencyProxy("detectionStrategyRepository", null),
    generationRepository: createOperationalDependencyProxy("generationRepository", generationRepository),
  } : {
    ...services,
    claimsReadRepository: services.claimReadRepository,
    ledgerRepository,
    tenantRepository,
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

  if (authenticationConfiguration.mode === "session" && !authenticationService) {
    throw new TypeError("Session authentication mode requires authenticationService.");
  }

  const resolvedAuthenticationProvider = authenticationProvider || (
    authenticationConfiguration.mode === "session"
      ? createSessionAuthenticationProvider({ authenticationService, configuration: authenticationConfiguration })
      : undefined
  );

  app.use(
    "*",
    createAuthenticationMiddleware({
      authenticationProvider: resolvedAuthenticationProvider,
    }),
  );

  if (authenticationConfiguration.mode === "session") {
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
        const claimsReadRepository = createApiClaimsReadRepository(pool, dataPlaneContext);
        const servicesForRequest = createDomainServices({
            reportStorage: resolvedReportStorage,
            ledgerRepository: repositories.ledger,
            investigationRepository: repositories.investigations,
            sharedFraudRegistryRepository: repositories.registry,
            fraudWorkflowRepository: repositories.fraudWorkflow,
            claimIngestionRepository: repositories.claims,
            claimReadRepository: claimsReadRepository,
            generationRepository: repositories.claimProcessingOutbox,
          });
        if (!reportServices.has(pool)) reportServices.set(pool, new Map());
        const tenantReportServices = reportServices.get(pool);
        const reportServiceKey = dataPlaneContext.operationalTenantId;
        if (!tenantReportServices.has(reportServiceKey)) {
          tenantReportServices.set(reportServiceKey, servicesForRequest.reportService);
        }
        return {
          ...servicesForRequest,
          claimsReadRepository: servicesForRequest.claimReadRepository,
          reportService: tenantReportServices.get(reportServiceKey),
          ledgerRepository: repositories.ledger,
          tenantRepository: repositories.tenants,
          detectionStrategyRepository: repositories.detectionStrategy,
          generationRepository: repositories.claimProcessingOutbox,
          operationalRepositories: repositories,
        };
      },
    }));
  }

  app.use(
    "*",
    createTenantContextMiddleware({
      tenantRepository: dependencies.tenantRepository,
    }),
  );

  if (authenticationConfiguration.mode === "session") {
    registerAuthRoutes(app, {
      authenticationService,
      configuration: authenticationConfiguration,
      configurationRepository: controlPlaneConfigurationRepository,
      controlPlaneService,
    });
  }

  registerAdminRoutes(app, {
    reportService: services.reportService,
    dataPlaneRuntime,
    detectionStrategyRepository: dependencies.detectionStrategyRepository,
    tenantRepository: dependencies.tenantRepository,
  });

  if (controlPlaneRepositories && controlPlaneService) {
    registerPlatformAdminRoutes(app, {
      controlPlaneRepositories,
      controlPlaneService,
      deploymentClass: authenticationConfiguration.deploymentClass,
    });
    registerSchemeAdminRoutes(app, {
      controlPlaneService,
    });
  }

  registerLedgerRoutes(app, {
    ledgerRepository: dependencies.ledgerRepository,
    tenantRepository: dependencies.tenantRepository,
  });

  registerDetectionRoutes(app, {
    reportService: dependencies.reportService,
    tenantRepository: dependencies.tenantRepository,
  });

  registerClaimsRoutes(app, {
    claimIngestionService: dependencies.claimIngestionService,
    claimsReadRepository: dependencies.claimsReadRepository,
    tenantRepository: dependencies.tenantRepository,
    logger: logEvent,
  });

  registerInvestigationsRoutes(app, {
    investigationService: dependencies.investigationService,
    fraudConfirmationService: dependencies.fraudConfirmationService,
    fraudReversalService: dependencies.fraudReversalService,
    tenantRepository: dependencies.tenantRepository,
    logger: logEvent,
  });

  registerRegistryRoutes(app, {
    registryService: dependencies.registryService,
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
