import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/apiClient", () => ({
  apiJson: vi.fn(),
  ApiError: class ApiError extends Error {},
  safeApiErrorMessage: (error, fallback) => error?.message || fallback,
}));

import { apiJson } from "../lib/apiClient";
import { PlatformAdminPage } from "../features/investigator/PlatformAdminPage";

const organisations = [{
  organisationId: "org-ubuntu",
  displayName: "Ubuntu Medical Scheme",
  canonicalSlug: "ubuntu-medical",
  deploymentClass: "production",
  status: "active",
}];

const releaseCommit = "a".repeat(40);
const releaseId = "11111111-1111-4111-8111-111111111111";

function configureApi() {
  apiJson.mockImplementation((path, options = {}) => {
    if (path === "/admin/platform/releases") {
      return Promise.resolve({
        available: true,
        actor: {
          userId: "platform-admin-1",
          canRequest: true,
          canApprove: true,
        },
        policy: {
          targetEnvironment: "production",
          reauthenticationRequired: true,
          distinctSecondApproverRequired: true,
          deploymentExecution: "github_actions",
        },
        currentDeployment: {
          releaseId: "22222222-2222-4222-8222-222222222222",
          promotionRequestId: "33333333-3333-4333-8333-333333333333",
          commitSha: "b".repeat(40),
          artifactDigest: "c".repeat(64),
          deployedAt: "2026-07-28T10:00:00.000Z",
          deploymentWorkflowRunId: "98765",
          deploymentWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/98765",
          sourceRepository: "Sbusiso-Mdingi/ClaimGuard-Network",
        },
        releases: [{
          releaseId,
          commitSha: releaseCommit,
          sourceRepository: "Sbusiso-Mdingi/ClaimGuard-Network",
          sourceBranch: "main",
          artifactDigest: "d".repeat(64),
          eligibleAt: "2026-07-29T08:00:00.000Z",
          ciWorkflowRunId: "1001",
          ciWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1001",
          securityWorkflowRunId: "1002",
          securityWorkflowRunUrl: "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/1002",
          current: false,
          promotionOpen: false,
          requestConfirmation: "PROMOTE aaaaaaaaaaaa TO PRODUCTION",
        }],
        promotionRequests: [],
      });
    }
    if (
      path === `/admin/platform/releases/${releaseId}/promotion-requests`
      && options.method === "POST"
    ) {
      return Promise.resolve({
        available: true,
        message: "Promotion requested.",
        auditEventId: "audit-release-1",
      });
    }
    if (path === "/admin/platform/global-detection-engine") {
      return Promise.resolve({
        strategy: {
          modelDeploymentId: "deployment-1",
          approved: true,
          configurationSource: "deployment_environment",
          writable: false,
          activationMode: "audited_prospective_transition",
        },
      });
    }
    if (
      path === "/admin/platform/model-deployments"
      && options.method === "POST"
    ) {
      return Promise.resolve({
        available: true,
        model: {
          deploymentId: "claimguard-ensemble:2.0.0",
          lifecycleStatus: "candidate",
        },
        auditEventId: "audit-1",
      });
    }
    if (path === "/admin/platform/model-deployments") {
      return Promise.resolve({
        available: true,
        models: [{
          deploymentId: "deployment-1",
          modelId: "claimguard-baseline",
          modelVersion: "1.0.0",
          displayName: "ClaimGuard baseline",
          ownerType: "claimguard",
          ownerOrganisationId: null,
          lifecycleStatus: "active",
          featureSchemaVersion: "claim-feature-schema-2026.2",
          decisionThreshold: 0.1,
          artifactSha256: null,
          containerImageDigest: null,
          runtimeApproved: true,
          fleetManaged: true,
        }],
      });
    }
    if (path === "/health") return Promise.resolve({ status: "ok" });
    if (path === "/ready") return Promise.resolve({ status: "ready", ready: true });
    if (path === "/admin/platform/organisations" && options.method === "POST") {
      return Promise.resolve({
        organisation: {
          organisationId: "org-new",
          displayName: "New Medical Scheme",
          canonicalSlug: "new-medical",
          deploymentClass: "production",
          status: "draft",
        },
        provisioningReview: null,
      });
    }
    if (path === "/admin/platform/organisations") return Promise.resolve({ organisations });
    if (path === "/admin/platform/organisations/org-ubuntu") {
      return Promise.resolve({ organisation: organisations[0], operations: [], provisioningReview: null });
    }
    if (path === "/admin/platform/organisations/org-ubuntu/integration") {
      return Promise.resolve({
        guide: { endpoint: "/api/claims", successStatus: 202 },
        credentials: [],
      });
    }
    return Promise.reject(new Error(`Unexpected request: ${path}`));
  });
}

describe("PlatformAdminLifecyclePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureApi();
  });

  afterEach(() => cleanup());

  test("preserves the draft organisation payload", async () => {
    render(<PlatformAdminPage />);
    const user = userEvent.setup();

    await screen.findByText("Ubuntu Medical Scheme");
    await user.type(screen.getByLabelText(/Organisation name/i), "New Medical Scheme");
    await user.type(screen.getByLabelText(/Canonical slug/i), "new-medical");
    await user.type(screen.getByLabelText(/Initial administrator name/i), "Nandi Dube");
    await user.type(screen.getByLabelText(/Initial administrator email/i), "nandi@example.com");
    await user.click(screen.getByRole("button", { name: /Create draft scheme/i }));

    await waitFor(() => {
      expect(apiJson).toHaveBeenCalledWith("/admin/platform/organisations", {
        method: "POST",
        body: JSON.stringify({
          displayName: "New Medical Scheme",
          canonicalSlug: "new-medical",
          deploymentClass: "production",
          organisationType: "medical_scheme",
          initialAdministrator: { displayName: "Nandi Dube", email: "nandi@example.com" },
        }),
      });
    });

    expect(await screen.findByText(/Draft organisation created/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Deployment class/i)).not.toBeInTheDocument();
  });

  test("enables only valid lifecycle actions for an active scheme", async () => {
    render(<PlatformAdminPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Ubuntu Medical Scheme/i }));

    expect(await screen.findByRole("heading", { name: "Ubuntu Medical Scheme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Request provisioning/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Upgrade data plane/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Activate organisation/i })).toBeDisabled();
    expect(screen.getByText("/api/claims")).toBeInTheDocument();
    expect(screen.getByText(/No integration credentials/i)).toBeInTheDocument();
  });

  test("shows the deployment-authoritative managed model without an unsafe save action", async () => {
    render(<PlatformAdminPage />);

    expect((await screen.findAllByText("deployment-1")).length).toBeGreaterThan(0);
    expect(screen.getByText("ClaimGuard baseline")).toBeInTheDocument();
    expect(screen.getByText("Approved deployment")).toBeInTheDocument();
    expect(screen.getByText("Deployment controlled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save configuration/i })).not.toBeInTheDocument();
  });

  test("registers a checksum-pinned inactive model candidate", async () => {
    render(<PlatformAdminPage />);
    const user = userEvent.setup();

    await screen.findByText("ClaimGuard baseline");
    await user.click(screen.getByText("Register an immutable model candidate"));
    await user.type(screen.getByLabelText("Display name"), "ClaimGuard ensemble 2");
    await user.type(screen.getByLabelText("Deployment ID"), "claimguard-ensemble:2.0.0");
    await user.type(screen.getByLabelText("Model ID"), "claimguard-ensemble");
    await user.type(screen.getByLabelText("Model version"), "2.0.0");
    await user.type(screen.getByLabelText("Decision threshold"), "0.19");
    await user.type(screen.getByLabelText("Artifact SHA-256"), "a".repeat(64));
    await user.type(
      screen.getByLabelText("Immutable container digest"),
      `registry/model@sha256:${"b".repeat(64)}`,
    );
    await user.click(screen.getByRole("button", { name: "Register candidate" }));

    await waitFor(() => {
      expect(apiJson).toHaveBeenCalledWith(
        "/admin/platform/model-deployments",
        {
          method: "POST",
          body: JSON.stringify({
            deploymentId: "claimguard-ensemble:2.0.0",
            modelId: "claimguard-ensemble",
            modelVersion: "2.0.0",
            displayName: "ClaimGuard ensemble 2",
            ownerType: "claimguard",
            ownerOrganisationId: null,
            requestSchemaVersion: "claimguard.claim-screening-request.v3",
            responseSchemaVersion: "claimguard.claim-screening-response.v3",
            featureSchemaVersion: "claim-feature-schema-2026.2",
            analysisMode: "PROSPECTIVE_CLAIM_SCREENING",
            decisionThreshold: 0.19,
            artifactSha256: "a".repeat(64),
            containerImageDigest: `registry/model@sha256:${"b".repeat(64)}`,
            capabilities: {
              prospectiveClaimScreening: true,
              networkEnrichment: false,
            },
            automaticAdverseAction: false,
          }),
        },
      );
    });
    expect(await screen.findByText("Model governance updated")).toBeInTheDocument();
  });

  test("activates a staged release through the audited catalogue operation", async () => {
    const deploymentId = "claimguard-claim-fraud-ensemble:2.1.1";
    apiJson.mockImplementation((path, options = {}) => {
      if (path === "/admin/platform/global-detection-engine") {
        return Promise.resolve({
          strategy: {
            modelDeploymentId: "claimguard-claim-fraud-baseline:1.0.0",
            approved: true,
          },
        });
      }
      if (
        path === `/admin/platform/model-deployments/${encodeURIComponent(deploymentId)}/activate`
        && options.method === "POST"
      ) {
        return Promise.resolve({
          activated: true,
          auditEventId: "104d8b58-b021-4a40-a5a2-b609a3cc2d0e",
        });
      }
      if (path === "/admin/platform/model-deployments") {
        return Promise.resolve({
          models: [{
            deploymentId,
            displayName: "ClaimGuard fraud ensemble 2.1.1",
            ownerType: "claimguard",
            ownerOrganisationId: null,
            lifecycleStatus: "candidate",
            featureSchemaVersion: "claim-feature-schema-2026.2",
            decisionThreshold: 0.049236234887246655,
            artifactSha256: "a".repeat(64),
            containerImageDigest: `registry/model@sha256:${"b".repeat(64)}`,
            runtimeApproved: false,
            fleetManaged: false,
          }],
        });
      }
      if (path === "/admin/platform/organisations") {
        return Promise.resolve({ organisations });
      }
      return Promise.reject(new Error(`Unexpected request: ${path}`));
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PlatformAdminPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", {
      name: "Activate staged release",
    }));

    await waitFor(() => {
      expect(apiJson).toHaveBeenCalledWith(
        `/admin/platform/model-deployments/${encodeURIComponent(deploymentId)}/activate`,
        {
          method: "POST",
          body: JSON.stringify({
            confirmation: `ACTIVATE ${deploymentId}`,
          }),
        },
      );
    });
    expect(await screen.findByText(/104d8b58-b021-4a40-a5a2-b609a3cc2d0e/))
      .toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(screen.queryByText("Model governance updated"))
        .not.toBeInTheDocument();
    });
  });

  test("shows immutable production provenance and requests promotion with step-up confirmation", async () => {
    render(<PlatformAdminPage />);
    const user = userEvent.setup();

    expect(await screen.findByText("Production deployment")).toBeInTheDocument();
    expect(screen.getByText("b".repeat(40))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Run 98765/i })).toHaveAttribute(
      "href",
      "https://github.com/Sbusiso-Mdingi/ClaimGuard-Network/actions/runs/98765",
    );
    expect(screen.getByRole("link", { name: /Passed · run 1001/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Passed · run 1002/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Request promotion" }));
    await user.type(
      screen.getByLabelText("Change reason"),
      "Promote the verified release after release review.",
    );
    await user.type(screen.getByLabelText("Current password"), "current-password");
    await user.type(
      screen.getByLabelText("Confirmation"),
      "PROMOTE aaaaaaaaaaaa TO PRODUCTION",
    );
    await user.click(screen.getByRole("button", { name: "Record governed action" }));

    await waitFor(() => {
      expect(apiJson).toHaveBeenCalledWith(
        `/admin/platform/releases/${releaseId}/promotion-requests`,
        {
          method: "POST",
          skipUnauthorizedHandler: true,
          body: JSON.stringify({
            password: "current-password",
            confirmation: "PROMOTE aaaaaaaaaaaa TO PRODUCTION",
            reason: "Promote the verified release after release review.",
          }),
        },
      );
    });
    expect(await screen.findByText(/Audit event audit-release-1/i)).toBeInTheDocument();
  });
});
