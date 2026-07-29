import assert from "node:assert/strict";
import test from "node:test";

import { createReleaseGovernanceRepository } from "../src/index.js";

const requestId = "44444444-4444-4444-8444-444444444444";
const releaseId = "11111111-1111-4111-8111-111111111111";
const commitSha = "a".repeat(40);

function releaseRow() {
  return {
    release_id: releaseId,
    commit_sha: commitSha,
    source_repository: "Sbusiso-Mdingi/ClaimGuard-Network",
    source_branch: "main",
    artifact_digest: "b".repeat(64),
    web_artifact_digest: "c".repeat(64),
    api_artifact_digest: "d".repeat(64),
    artifact_name: `claimguard-release-${commitSha}`,
    artifact_workflow_run_id: "1000",
    artifact_workflow_run_url: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1000",
    ci_workflow_run_id: "1001",
    ci_workflow_run_url: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1001",
    security_workflow_run_id: "1002",
    security_workflow_run_url: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1002",
    ci_conclusion: "success",
    security_conclusion: "success",
    eligible_at: new Date("2026-07-29T10:00:00.000Z"),
    registered_by: "github-actions",
    created_at: new Date("2026-07-29T10:00:00.000Z"),
  };
}

function requestRow(overrides = {}) {
  return {
    promotion_request_id: requestId,
    release_id: releaseId,
    commit_sha: commitSha,
    artifact_digest: "b".repeat(64),
    target_environment: "production",
    status: "approved",
    request_reason: "Promote after CI and security review.",
    requested_by: "platform-admin-1",
    requested_at: new Date("2026-07-29T11:00:00.000Z"),
    request_reauthenticated_at: new Date("2026-07-29T11:00:00.000Z"),
    approved_by: "platform-admin-2",
    approved_at: new Date("2026-07-29T11:05:00.000Z"),
    approval_reauthenticated_at: new Date("2026-07-29T11:05:00.000Z"),
    bootstrap_request: 0,
    created_at: new Date("2026-07-29T11:00:00.000Z"),
    updated_at: new Date("2026-07-29T11:05:00.000Z"),
    ...overrides,
  };
}

class MemoryExecutor {
  constructor() {
    this.releases = new Map();
    this.requests = new Map();
    this.deployments = new Map();
  }

  releaseRowById(id) {
    return this.releases.get(id) || null;
  }

  joinedRequest(id) {
    const request = this.requests.get(id);
    if (!request) return null;
    const release = this.releases.get(request.release_id);
    return {
      ...request,
      commit_sha: release?.commit_sha || null,
      artifact_digest: release?.artifact_digest || null,
    };
  }

  joinedDeployment(row) {
    if (!row) return null;
    const release = this.releases.get(row.release_id);
    return {
      ...row,
      commit_sha: release.commit_sha,
      artifact_digest: release.artifact_digest,
      web_artifact_digest: release.web_artifact_digest,
      api_artifact_digest: release.api_artifact_digest,
      source_repository: release.source_repository,
    };
  }

  async execute(sql, params = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("SELECT * FROM platform_release_candidates WHERE commit_sha")) {
      return [[...this.releases.values()].filter((row) => row.commit_sha === params[0]).slice(0, 1)];
    }
    if (normalized.startsWith("SELECT * FROM platform_release_candidates WHERE release_id")) {
      const row = this.releases.get(params[0]);
      return [row ? [row] : []];
    }
    if (
      normalized.startsWith("SELECT * FROM platform_release_candidates")
      && normalized.includes("ORDER BY eligible_at")
    ) {
      return [[...this.releases.values()].reverse()];
    }
    if (normalized.includes("FROM platform_release_promotion_requests pr")) {
      if (normalized.includes("WHERE pr.promotion_request_id")) {
        const row = this.joinedRequest(params[0]);
        return [row ? [row] : []];
      }
      return [[...this.requests.keys()].reverse().map((id) => this.joinedRequest(id))];
    }
    if (
      normalized.startsWith("SELECT d.*")
      && normalized.includes("WHERE d.target_environment")
    ) {
      const rows = [...this.deployments.values()]
        .filter((row) => row.target_environment === params[0])
        .sort((left, right) => right.deployed_at - left.deployed_at);
      return [rows[0] ? [this.joinedDeployment(rows[0])] : []];
    }
    if (
      normalized.startsWith("SELECT d.*")
      && normalized.includes("WHERE d.promotion_request_id")
    ) {
      const row = [...this.deployments.values()]
        .find((candidate) => candidate.promotion_request_id === params[0]);
      return [row ? [this.joinedDeployment(row)] : []];
    }
    if (normalized.startsWith("SELECT deployment_record_id FROM platform_release_deployments")) {
      return [[...this.deployments.values()].slice(0, 1)];
    }
    if (normalized.startsWith("SELECT promotion_request_id FROM platform_release_promotion_requests")) {
      return [[...this.requests.values()].slice(0, 1)];
    }

    if (normalized.startsWith("INSERT INTO platform_release_candidates")) {
      const [
        id, sha, repository, branch, artifactDigest, webDigest, apiDigest,
        artifactName, artifactRunId, artifactRunUrl, ciRunId, ciRunUrl,
        securityRunId, securityRunUrl, ciConclusion, securityConclusion,
        eligibleAt, registeredBy,
      ] = params;
      this.releases.set(id, {
        release_id: id,
        commit_sha: sha,
        source_repository: repository,
        source_branch: branch,
        artifact_digest: artifactDigest,
        web_artifact_digest: webDigest,
        api_artifact_digest: apiDigest,
        artifact_name: artifactName,
        artifact_workflow_run_id: artifactRunId,
        artifact_workflow_run_url: artifactRunUrl,
        ci_workflow_run_id: ciRunId,
        ci_workflow_run_url: ciRunUrl,
        security_workflow_run_id: securityRunId,
        security_workflow_run_url: securityRunUrl,
        ci_conclusion: ciConclusion,
        security_conclusion: securityConclusion,
        eligible_at: eligibleAt,
        registered_by: registeredBy,
        created_at: eligibleAt,
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("INSERT INTO platform_release_promotion_requests")) {
      if (params.length === 6) {
        const [id, release, reason, actor, requestedAt, reauthenticatedAt] = params;
        this.requests.set(id, {
          promotion_request_id: id,
          release_id: release,
          target_environment: "production",
          status: "pending_approval",
          request_reason: reason,
          requested_by: actor,
          requested_at: requestedAt,
          request_reauthenticated_at: reauthenticatedAt,
          bootstrap_request: 0,
          created_at: requestedAt,
          updated_at: requestedAt,
        });
      } else {
        const [
          id, release, reason, requestedBy, requestedAt,
          requestReauthenticatedAt, approvedBy, approvedAt,
          approvalReauthenticatedAt, workflowId, workflowUrl, startedAt,
        ] = params;
        this.requests.set(id, {
          promotion_request_id: id,
          release_id: release,
          target_environment: "production",
          status: "deploying",
          request_reason: reason,
          requested_by: requestedBy,
          requested_at: requestedAt,
          request_reauthenticated_at: requestReauthenticatedAt,
          approved_by: approvedBy,
          approved_at: approvedAt,
          approval_reauthenticated_at: approvalReauthenticatedAt,
          deployment_workflow_run_id: workflowId,
          deployment_workflow_run_url: workflowUrl,
          deployment_started_at: startedAt,
          bootstrap_request: 1,
          created_at: requestedAt,
          updated_at: requestedAt,
        });
      }
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("UPDATE platform_release_promotion_requests SET status = 'approved'")) {
      const [actor, approvedAt, reauthenticatedAt, id] = params;
      Object.assign(this.requests.get(id), {
        status: "approved",
        approved_by: actor,
        approved_at: approvedAt,
        approval_reauthenticated_at: reauthenticatedAt,
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("UPDATE platform_release_promotion_requests SET status = 'rejected'")) {
      const [actor, rejectedAt, reason, id] = params;
      Object.assign(this.requests.get(id), {
        status: "rejected",
        rejected_by: actor,
        rejected_at: rejectedAt,
        rejection_reason: reason,
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("UPDATE platform_release_promotion_requests SET status = 'deploying'")) {
      const [workflowId, workflowUrl, startedAt, id] = params;
      Object.assign(this.requests.get(id), {
        status: "deploying",
        deployment_workflow_run_id: workflowId,
        deployment_workflow_run_url: workflowUrl,
        deployment_started_at: startedAt,
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("INSERT INTO platform_release_deployments")) {
      const [id, release, request, workflowId, workflowUrl, deployedAt, actor] = params;
      this.deployments.set(id, {
        deployment_record_id: id,
        release_id: release,
        promotion_request_id: request,
        target_environment: "production",
        deployment_workflow_run_id: workflowId,
        deployment_workflow_run_url: workflowUrl,
        deployed_at: deployedAt,
        recorded_by: actor,
        created_at: deployedAt,
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("UPDATE platform_release_promotion_requests SET status = 'deployed'")) {
      const [completedAt, id] = params;
      Object.assign(this.requests.get(id), {
        status: "deployed",
        completed_at: completedAt,
        failure_summary: null,
      });
      return [{ affectedRows: 1 }];
    }
    if (normalized.startsWith("UPDATE platform_release_promotion_requests SET status = 'failed'")) {
      const [completedAt, failureSummary, id] = params;
      Object.assign(this.requests.get(id), {
        status: "failed",
        completed_at: completedAt,
        failure_summary: failureSummary,
      });
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }
}

function eligibleRelease(overrides = {}) {
  const sha = overrides.commitSha || commitSha;
  return {
    releaseId: overrides.releaseId || releaseId,
    commitSha: sha,
    sourceRepository: "Sbusiso-Mdingi/ClaimGuard-Network",
    sourceBranch: "main",
    artifactDigest: overrides.artifactDigest || "b".repeat(64),
    webArtifactDigest: overrides.webArtifactDigest || "c".repeat(64),
    apiArtifactDigest: overrides.apiArtifactDigest || "d".repeat(64),
    artifactName: `claimguard-release-${sha}`,
    artifactWorkflowRunId: "1000",
    artifactWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1000",
    ciWorkflowRunId: "1001",
    ciWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1001",
    securityWorkflowRunId: "1002",
    securityWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1002",
    ciConclusion: "success",
    securityConclusion: "success",
    eligibleAt: new Date("2026-07-29T10:00:00.000Z"),
    registeredBy: "github-actions",
    ...overrides,
  };
}

test("only commits with successful CI and security gates can be registered", async () => {
  const repository = createReleaseGovernanceRepository({
    async execute() {
      throw new Error("The database must not be queried for an ineligible release.");
    },
  });

  await assert.rejects(
    () => repository.registerEligibleRelease({
      commitSha,
      sourceRepository: "Sbusiso-Mdingi/ClaimGuard-Network",
      sourceBranch: "main",
      artifactDigest: "b".repeat(64),
      webArtifactDigest: "c".repeat(64),
      apiArtifactDigest: "d".repeat(64),
      artifactName: `claimguard-release-${commitSha}`,
      artifactWorkflowRunId: "1000",
      artifactWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1000",
      ciWorkflowRunId: "1001",
      ciWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1001",
      securityWorkflowRunId: "1002",
      securityWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1002",
      ciConclusion: "success",
      securityConclusion: "failure",
      registeredBy: "github-actions",
    }),
    (error) => error.code === "RELEASE_GATES_INCOMPLETE",
  );
});

test("a requester cannot approve their own production promotion", async () => {
  const repository = createReleaseGovernanceRepository({
    async execute(sql) {
      if (sql.includes("FROM platform_release_promotion_requests")) {
        return [[requestRow({ status: "pending_approval", approved_by: null })]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  await assert.rejects(
    () => repository.approvePromotionRequest({
      promotionRequestId: requestId,
      approvedBy: "platform-admin-1",
      approvalReauthenticatedAt: new Date(),
    }),
    (error) => error.code === "SECOND_APPROVER_REQUIRED",
  );
});

test("deployment authorization is pinned to the approved commit", async () => {
  const repository = createReleaseGovernanceRepository({
    async execute(sql) {
      if (sql.includes("FROM platform_release_promotion_requests")) {
        return [[requestRow()]];
      }
      if (sql.includes("FROM platform_release_candidates WHERE release_id")) {
        return [[releaseRow()]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });

  await assert.rejects(
    () => repository.authorizePromotionDeployment({
      promotionRequestId: requestId,
      commitSha: "e".repeat(40),
      deploymentWorkflowRunId: "2000",
      deploymentWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/2000",
    }),
    (error) => error.code === "PROMOTION_COMMIT_MISMATCH",
  );
});

test("release lifecycle persists registration, approval, deployment and idempotent completion", async () => {
  const executor = new MemoryExecutor();
  const repository = createReleaseGovernanceRepository(executor);
  const registered = await repository.registerEligibleRelease(eligibleRelease());
  assert.equal(registered.releaseId, releaseId);
  assert.equal((await repository.registerEligibleRelease(eligibleRelease())).releaseId, releaseId);
  assert.equal((await repository.listEligibleReleases()).length, 1);
  await assert.rejects(
    () => repository.registerEligibleRelease(eligibleRelease({
      artifactDigest: "e".repeat(64),
    })),
    (error) => error.code === "RELEASE_IMMUTABILITY_CONFLICT",
  );

  const requested = await repository.createPromotionRequest({
    promotionRequestId: requestId,
    releaseId,
    requestReason: "Promote after CI and security review.",
    requestedBy: "platform-admin-1",
    requestReauthenticatedAt: new Date("2026-07-29T11:00:00.000Z"),
  });
  assert.equal(requested.status, "pending_approval");
  assert.equal((await repository.listPromotionRequests()).length, 1);

  const approved = await repository.approvePromotionRequest({
    promotionRequestId: requestId,
    approvedBy: "platform-admin-2",
    approvalReauthenticatedAt: new Date("2026-07-29T11:05:00.000Z"),
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, "platform-admin-2");

  const authorized = await repository.authorizePromotionDeployment({
    promotionRequestId: requestId,
    commitSha,
    deploymentWorkflowRunId: "2000",
    deploymentWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/2000",
  });
  assert.equal(authorized.request.status, "deploying");
  assert.equal(authorized.release.artifactDigest, "b".repeat(64));

  const completed = await repository.completePromotionDeployment({
    promotionRequestId: requestId,
    deploymentRecordId: "55555555-5555-4555-8555-555555555555",
    recordedBy: "github-actions",
  });
  assert.equal(completed.request.status, "deployed");
  assert.equal(completed.deployment.commitSha, commitSha);
  assert.equal((await repository.getCurrentDeployment()).releaseId, releaseId);
  assert.equal(
    (await repository.completePromotionDeployment({
      promotionRequestId: requestId,
      recordedBy: "github-actions",
    })).deployment.promotionRequestId,
    requestId,
  );
  await assert.rejects(
    () => repository.createPromotionRequest({
      releaseId,
      requestReason: "Attempt to promote the current release again.",
      requestedBy: "platform-admin-1",
      requestReauthenticatedAt: new Date(),
    }),
    (error) => error.code === "RELEASE_ALREADY_DEPLOYED",
  );
});

test("release lifecycle records rejection, deployment failure and one-time bootstrap", async () => {
  const executor = new MemoryExecutor();
  const repository = createReleaseGovernanceRepository(executor);
  const secondReleaseId = "22222222-2222-4222-8222-222222222222";
  const secondRequestId = "66666666-6666-4666-8666-666666666666";
  await repository.registerEligibleRelease(eligibleRelease({
    releaseId: secondReleaseId,
    commitSha: "e".repeat(40),
    artifactDigest: "f".repeat(64),
    webArtifactDigest: "1".repeat(64),
    apiArtifactDigest: "2".repeat(64),
  }));
  await repository.createPromotionRequest({
    promotionRequestId: secondRequestId,
    releaseId: secondReleaseId,
    requestReason: "Promote this release after the operational review.",
    requestedBy: "platform-admin-1",
    requestReauthenticatedAt: new Date(),
  });
  const rejected = await repository.rejectPromotionRequest({
    promotionRequestId: secondRequestId,
    rejectedBy: "platform-admin-2",
    rejectionReason: "The operational review is not yet complete.",
  });
  assert.equal(rejected.status, "rejected");
  await assert.rejects(
    () => repository.rejectPromotionRequest({
      promotionRequestId: secondRequestId,
      rejectedBy: "platform-admin-2",
      rejectionReason: "Reject the same request again.",
    }),
    (error) => error.code === "PROMOTION_REQUEST_NOT_REJECTABLE",
  );

  const thirdReleaseId = "33333333-3333-4333-8333-333333333333";
  const thirdRequestId = "77777777-7777-4777-8777-777777777777";
  await repository.registerEligibleRelease(eligibleRelease({
    releaseId: thirdReleaseId,
    commitSha: "3".repeat(40),
    artifactDigest: "4".repeat(64),
    webArtifactDigest: "5".repeat(64),
    apiArtifactDigest: "6".repeat(64),
  }));
  await repository.createPromotionRequest({
    promotionRequestId: thirdRequestId,
    releaseId: thirdReleaseId,
    requestReason: "Promote this release after the second review.",
    requestedBy: "platform-admin-1",
    requestReauthenticatedAt: new Date(),
  });
  await repository.approvePromotionRequest({
    promotionRequestId: thirdRequestId,
    approvedBy: "platform-admin-2",
    approvalReauthenticatedAt: new Date(),
  });
  await repository.authorizePromotionDeployment({
    promotionRequestId: thirdRequestId,
    commitSha: "3".repeat(40),
    deploymentWorkflowRunId: "3000",
    deploymentWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/3000",
  });
  const failed = await repository.failPromotionDeployment({
    promotionRequestId: thirdRequestId,
    failureSummary: "Health verification failed.",
  });
  assert.equal(failed.status, "failed");
  assert.equal(
    (await repository.failPromotionDeployment({
      promotionRequestId: thirdRequestId,
      failureSummary: "Health verification failed.",
    })).status,
    "failed",
  );

  const bootstrapExecutor = new MemoryExecutor();
  const bootstrapRepository = createReleaseGovernanceRepository(bootstrapExecutor);
  await bootstrapRepository.registerEligibleRelease(eligibleRelease());
  const bootstrap = await bootstrapRepository.createBootstrapDeploymentRequest({
    promotionRequestId: requestId,
    releaseId,
    actor: "github-actions",
    deploymentWorkflowRunId: "4000",
    deploymentWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/4000",
  });
  assert.equal(bootstrap.request.bootstrapRequest, true);
  assert.equal(bootstrap.request.status, "deploying");
  await assert.rejects(
    () => bootstrapRepository.createBootstrapDeploymentRequest({
      releaseId,
      actor: "github-actions",
      deploymentWorkflowRunId: "4001",
      deploymentWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/4001",
    }),
    (error) => error.code === "RELEASE_GOVERNANCE_ALREADY_INITIALISED",
  );
});
