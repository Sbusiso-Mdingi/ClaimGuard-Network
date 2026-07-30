import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";

import { createControlPlanePool } from "./client.js";
import {
  assertDistinctDatabaseUrls,
  isControlPlaneShadowEnabled,
  requireControlPlaneDatabaseUrl,
  requireOperationalDatabaseUrl,
} from "./config.js";
import { createControlPlaneService } from "./control-plane-service.js";
import { provisionDemoAccounts } from "./demo-provisioning.js";
import {
  bootstrapDevelopmentPlatformAdministrator,
  DEVELOPMENT_PLATFORM_ADMIN_BOOTSTRAP_CONFIRMATION,
  getDevelopmentPlatformAdminBootstrapStatus,
} from "./development-platform-admin-bootstrap.js";
import { getShadowDiagnostics } from "./diagnostics.js";
import {
  applyUnambiguousLegacyMappings,
  compareLegacyTenantInventory,
  readLegacyTenantInventory,
} from "./legacy-inventory.js";
import { applyControlPlaneMigrations, getControlPlaneMigrationStatus } from "./migrate.js";
import { createControlPlaneRepositories } from "./repositories.js";

function parseArguments(argv) {
  const values = new Map();
  const flags = new Set();
  for (const argument of argv) {
    if (!argument.startsWith("--")) continue;
    const [key, value] = argument.slice(2).split("=", 2);
    if (value === undefined) flags.add(key);
    else values.set(key, value);
  }
  return { flags, values };
}

function json(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runInventory({ flags, values }) {
  const controlUrl = requireControlPlaneDatabaseUrl();
  const operationalUrl = requireOperationalDatabaseUrl();
  assertDistinctDatabaseUrls(controlUrl, operationalUrl);
  const apply = flags.has("apply");
  if (apply && !isControlPlaneShadowEnabled()) {
    throw new Error("CONTROL_PLANE_SHADOW_ENABLED=true is required for inventory --apply.");
  }
  if (apply && !values.get("deployment-class")) {
    throw new Error("inventory --apply requires --deployment-class=local|demo|pilot|production.");
  }

  const controlPool = createControlPlanePool(controlUrl);
  const operationalPool = mysql.createPool((await import("./client.js")).buildControlPlaneConnectionOptions(operationalUrl));
  try {
    const repositories = createControlPlaneRepositories(controlPool);
    const [tenants, organisations, mappings] = await Promise.all([
      readLegacyTenantInventory(operationalPool),
      repositories.organisations.list(),
      repositories.legacyMappings.list(),
    ]);
    const report = compareLegacyTenantInventory({ tenants, organisations, mappings });
    if (!apply) {
      json({ mode: "dry-run", operationalRowsModified: 0, report });
      return;
    }
    const service = createControlPlaneService({ pool: controlPool, repositories });
    const results = await applyUnambiguousLegacyMappings({
      report,
      deploymentClass: values.get("deployment-class"),
      service,
      repositories,
    });
    json({ mode: "apply-shadow", operationalRowsModified: 0, results });
  } finally {
    await Promise.all([controlPool.end(), operationalPool.end()]);
  }
}

async function runDemoProvisioning({ values }) {
  if (String(process.env.DEPLOYMENT_CLASS || "").toLowerCase() !== "demo") {
    throw new Error("Demo provisioning requires DEPLOYMENT_CLASS=demo.");
  }
  if (values.get("confirm") !== "PROVISION_DEMO_ACCOUNTS") {
    throw new Error("Demo provisioning requires --confirm=PROVISION_DEMO_ACCOUNTS.");
  }
  const controlUrl = requireControlPlaneDatabaseUrl();
  const operationalUrl = requireOperationalDatabaseUrl();
  assertDistinctDatabaseUrls(controlUrl, operationalUrl);
  const controlPool = createControlPlanePool(controlUrl);
  const operationalPool = mysql.createPool((await import("./client.js")).buildControlPlaneConnectionOptions(operationalUrl));
  try {
    const repositories = createControlPlaneRepositories(controlPool);
    const service = createControlPlaneService({ pool: controlPool, repositories });
    const tenants = await readLegacyTenantInventory(operationalPool);
    const result = await provisionDemoAccounts({
      tenants, repositories, service, executor: controlPool,
      operationalDatabaseName: new URL(operationalUrl).pathname.replace(/^\//, ""),
    });
    json({
      warning: "These generated demo passwords are shown once. Store them only in the approved deployment secret mechanism.",
      ...result,
    });
  } finally {
    await Promise.all([controlPool.end(), operationalPool.end()]);
  }
}

async function runDevelopmentPlatformAdminBootstrap(command, { values }) {
  const pool = createControlPlanePool(requireControlPlaneDatabaseUrl());
  try {
    const repositories = createControlPlaneRepositories(pool);
    if (command === "development-platform-admin-bootstrap-status") {
      json(await getDevelopmentPlatformAdminBootstrapStatus({ repositories }));
      return;
    }
    const result = await bootstrapDevelopmentPlatformAdministrator(
      {
        allowDevelopmentBootstrap:
          process.env.CLAIMGUARD_ALLOW_DEVELOPMENT_ADMIN_BOOTSTRAP === "true",
        confirmation: values.get("confirm"),
        expectedExistingAdministratorId: requiredArgument(
          values,
          "expected-existing-administrator-id",
        ),
        displayName: requiredArgument(values, "display-name"),
        email: requiredArgument(values, "email"),
        username: requiredArgument(values, "username"),
        password:
          process.env.CLAIMGUARD_DEVELOPMENT_PLATFORM_ADMIN_PASSWORD,
        reason: requiredArgument(values, "reason"),
        actor: values.get("actor") || "development-bootstrap-operator",
        correlationId: values.get("correlation-id") || null,
      },
      { repositories },
    );
    json({
      ...result,
      confirmation:
        DEVELOPMENT_PLATFORM_ADMIN_BOOTSTRAP_CONFIRMATION,
      passwordReturned: false,
    });
  } finally {
    await pool.end();
  }
}

function requiredArgument(values, name) {
  const value = String(values.get(name) || "").trim();
  if (!value) throw new Error(`--${name}=... is required.`);
  return value;
}

async function runReleaseGovernance(command, { values }) {
  const pool = createControlPlanePool(requireControlPlaneDatabaseUrl());
  try {
    const repositories = createControlPlaneRepositories(pool);
    if (command === "release-status") {
      const [currentDeployment, releases, promotionRequests] = await Promise.all([
        repositories.releaseGovernance.getCurrentDeployment("production"),
        repositories.releaseGovernance.listEligibleReleases({ limit: 20 }),
        repositories.releaseGovernance.listPromotionRequests({ limit: 30 }),
      ]);
      json({ currentDeployment, releases, promotionRequests });
      return;
    }

    if (command === "release-register") {
      const result = await repositories.runInTransaction(async (transaction) => {
        const release = await transaction.releaseGovernance.registerEligibleRelease({
          commitSha: requiredArgument(values, "commit-sha"),
          sourceRepository: requiredArgument(values, "repository"),
          sourceBranch: values.get("branch") || "main",
          artifactDigest: requiredArgument(values, "artifact-digest"),
          webArtifactDigest: requiredArgument(values, "web-artifact-digest"),
          apiArtifactDigest: requiredArgument(values, "api-artifact-digest"),
          artifactName: requiredArgument(values, "artifact-name"),
          artifactWorkflowRunId: requiredArgument(values, "artifact-workflow-run-id"),
          artifactWorkflowRunUrl: requiredArgument(values, "artifact-workflow-run-url"),
          ciWorkflowRunId: requiredArgument(values, "ci-workflow-run-id"),
          ciWorkflowRunUrl: requiredArgument(values, "ci-workflow-run-url"),
          securityWorkflowRunId: requiredArgument(values, "security-workflow-run-id"),
          securityWorkflowRunUrl: requiredArgument(values, "security-workflow-run-url"),
          ciConclusion: "success",
          securityConclusion: "success",
          eligibleAt: new Date(),
          registeredBy: values.get("actor") || "github-actions",
        });
        const audit = await transaction.security.recordPlatformAudit({
          actorType: "service",
          actorId: values.get("actor") || "github-actions",
          organisationScopeId: null,
          action: "platform_release.register_eligible",
          targetType: "platform_release",
          targetId: release.releaseId,
          beforeSummary: null,
          afterSummary: {
            commitSha: release.commitSha,
            artifactDigest: release.artifactDigest,
            ciWorkflowRunId: release.ciWorkflowRunId,
            securityWorkflowRunId: release.securityWorkflowRunId,
            ciConclusion: release.ciConclusion,
            securityConclusion: release.securityConclusion,
          },
          correlationId: values.get("correlation-id") || null,
          outcome: "success",
          source: "release-governance-cli",
        });
        return { release, auditEventId: audit.auditEventId };
      });
      json(result);
      return;
    }

    if (command === "release-authorize" || command === "release-bootstrap") {
      const result = await repositories.runInTransaction(async (transaction) => {
        const common = {
          deploymentWorkflowRunId: requiredArgument(values, "workflow-run-id"),
          deploymentWorkflowRunUrl: requiredArgument(values, "workflow-run-url"),
          deploymentStartedAt: new Date(),
        };
        const authorized = command === "release-bootstrap"
          ? await transaction.releaseGovernance.createBootstrapDeploymentRequest({
              ...common,
              releaseId: requiredArgument(values, "release-id"),
              actor: values.get("actor") || "github-actions",
            })
          : await transaction.releaseGovernance.authorizePromotionDeployment({
              ...common,
              promotionRequestId: requiredArgument(values, "promotion-request-id"),
              commitSha: requiredArgument(values, "commit-sha"),
            });
        const audit = await transaction.security.recordPlatformAudit({
          actorType: "service",
          actorId: values.get("actor") || "github-actions",
          organisationScopeId: null,
          action: command === "release-bootstrap"
            ? "platform_release.bootstrap_deployment"
            : "platform_release.authorize_deployment",
          targetType: "platform_release_promotion",
          targetId: authorized.request.promotionRequestId,
          beforeSummary: {
            status: command === "release-bootstrap" ? null : "approved",
          },
          afterSummary: {
            status: authorized.request.status,
            commitSha: authorized.release.commitSha,
            artifactDigest: authorized.release.artifactDigest,
            workflowRunId: authorized.request.deploymentWorkflowRunId,
            bootstrap: authorized.request.bootstrapRequest,
          },
          correlationId: values.get("correlation-id") || null,
          outcome: "success",
          source: "release-governance-cli",
        });
        return {
          promotionRequest: authorized.request,
          release: authorized.release,
          auditEventId: audit.auditEventId,
        };
      });
      json(result);
      return;
    }

    if (command === "release-complete" || command === "release-fail") {
      const result = await repositories.runInTransaction(async (transaction) => {
        const promotionRequestId = requiredArgument(values, "promotion-request-id");
        const operation = command === "release-complete"
          ? await transaction.releaseGovernance.completePromotionDeployment({
              promotionRequestId,
              deployedAt: new Date(),
              recordedBy: values.get("actor") || "github-actions",
            })
          : {
              request: await transaction.releaseGovernance.failPromotionDeployment({
                promotionRequestId,
                completedAt: new Date(),
                failureSummary: values.get("failure-summary") || "Production deployment workflow failed.",
              }),
              deployment: null,
            };
        const audit = await transaction.security.recordPlatformAudit({
          actorType: "service",
          actorId: values.get("actor") || "github-actions",
          organisationScopeId: null,
          action: command === "release-complete"
            ? "platform_release.complete_deployment"
            : "platform_release.fail_deployment",
          targetType: "platform_release_promotion",
          targetId: promotionRequestId,
          beforeSummary: { status: "deploying" },
          afterSummary: {
            status: operation.request.status,
            deploymentRecordId: operation.deployment?.deploymentRecordId || null,
            commitSha: operation.deployment?.commitSha || operation.request.commitSha,
          },
          correlationId: values.get("correlation-id") || null,
          outcome: command === "release-complete" ? "success" : "failure",
          source: "release-governance-cli",
        });
        return { ...operation, auditEventId: audit.auditEventId };
      });
      json(result);
      return;
    }

    throw new Error("Unsupported release governance command.");
  } finally {
    await pool.end();
  }
}

export async function runControlPlaneCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  const args = parseArguments(argv.slice(1));
  if (command === "inventory") return runInventory(args);
  if (command === "provision-demo") return runDemoProvisioning(args);
  if ([
    "development-platform-admin-bootstrap-status",
    "development-platform-admin-bootstrap",
  ].includes(command)) {
    return runDevelopmentPlatformAdminBootstrap(command, args);
  }
  if ([
    "release-status",
    "release-register",
    "release-authorize",
    "release-bootstrap",
    "release-complete",
    "release-fail",
  ].includes(command)) return runReleaseGovernance(command, args);

  const pool = createControlPlanePool(requireControlPlaneDatabaseUrl());
  try {
    if (command === "migrate") json(await applyControlPlaneMigrations(pool));
    else if (command === "status") json(await getControlPlaneMigrationStatus(pool));
    else if (command === "diagnose") json(await getShadowDiagnostics(pool));
    else throw new Error("Unsupported control-plane command.");
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runControlPlaneCli().catch((error) => {
    process.stderr.write(`${JSON.stringify({ error: error.code || error.name || "Error", message: error.message })}\n`);
    process.exitCode = 1;
  });
}
