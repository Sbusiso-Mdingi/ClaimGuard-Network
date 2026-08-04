import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaimDetail, ClaimsView } from "./DesktopWorkspace";

const richClaim = {
  claimId: "CLAIM-RICH-1",
  currentClaimVersion: 4,
  memberId: "8F1A-MEMBER",
  providerId: "7B2C-PROVIDER",
  member: { displayName: "Amahle Nkosi", dateOfBirth: "1992-04-12", gender: "F", homeRegion: "Gauteng", joinDate: "2020-01-15" },
  provider: { displayName: "Dr Priya Naidoo Family Practice With An Exceptionally Long Facility Name That Must Wrap", practiceNumber: "PR-1001", specialty: "General Practice", kind: "PRACTICE", category: "GENERAL_PRACTITIONER", region: "Gauteng" },
  serviceDate: "2026-07-20",
  receivedDate: "2026-07-23",
  submissionLagDays: 3,
  billedAmount: 1250.5,
  quantity: 2,
  billingCode: "0190",
  benefitOption: "COMPREHENSIVE",
  networkType: "DSP",
  lineType: "PROFESSIONAL_SERVICE",
  tariffDiscipline: "014",
  diagnosisCode: "Z76.0",
  billingProviderKind: "PRACTICE",
  billingProviderCategory: "GENERAL_PRACTITIONER",
  renderingPractitionerId: "RP-200",
  renderingPractitionerCategory: "MEDICAL_PRACTITIONER",
  renderingKnownToBillingProvider: true,
  status: "FLAGGED",
  processingStatus: "scored",
  riskScore: 82,
  riskLevel: "High",
  evidence: ["One unfamiliar model input was detected."],
  triggeredRules: ["MODEL_REVIEW_RECOMMENDED"],
  detection: {
    modelDeploymentId: "model:sealed",
    featureSchemaVersion: "claim-feature-schema-2026.2",
    scoredAt: "2026-07-23T08:01:00.000Z",
    inputDrift: {
      signals: [{ feature: "diagnosis_code", kind: "UNSEEN_CATEGORY", observed: "Z76.0" }],
    },
  },
};

function detail(claim = richClaim) {
  return render(<ClaimDetail payload={{ claim, fetchedAt: "2026-07-23T08:02:00.000Z" }} loading={false} error="" offline={false} onClose={vi.fn()} onOpenInvestigation={vi.fn()} onCreateInvestigation={vi.fn()} canViewInvestigations={false} canCreateInvestigations={false} canAssignInvestigations={false} investigators={[]} writesAllowed />);
}

afterEach(() => cleanup());

describe("desktop claim investigation context", () => {
  it("renders patient, provider, classification, model, and novelty context without changing the score", () => {
    detail();
    expect(screen.getByRole("heading", { name: "Patient" })).toBeInTheDocument();
    expect(screen.getByText("Amahle Nkosi")).toBeInTheDocument();
    expect(screen.getByText(/Member ID: 8F1A-MEMBER/)).toBeInTheDocument();
    expect(screen.getByText(/Dr Priya Naidoo Family Practice/)).toHaveClass("break-words");
    expect(screen.getByText(/Provider ID: 7B2C-PROVIDER/)).toBeInTheDocument();
    const classification = screen.getByRole("heading", { name: "Claim Classification" }).closest("section");
    expect(within(classification).getByText("Z76.0")).toBeInTheDocument();
    expect(within(classification).getByText("PROFESSIONAL_SERVICE")).toBeInTheDocument();
    expect(within(classification).getByText("3")).toBeInTheDocument();
    expect(screen.getAllByText("Unknown to deployed model").length).toBeGreaterThan(0);
    expect(screen.getByText(/does not by itself prove that the claim is fraudulent/i)).toBeInTheDocument();
    expect(screen.getByText("82.0 risk")).toBeInTheDocument();
  });

  it("uses safe identity fallbacks while keeping identifiers visible", () => {
    detail({ ...richClaim, member: null, provider: null });
    expect(screen.getByText("Unknown patient")).toBeInTheDocument();
    expect(screen.getByText("Unknown provider")).toBeInTheDocument();
    expect(screen.getByText(/Member ID: 8F1A-MEMBER/)).toBeInTheDocument();
    expect(screen.getByText(/Provider ID: 7B2C-PROVIDER/)).toBeInTheDocument();
  });

  it("shows ten cached claims initially, reveals more, and searches IDs and classifications", async () => {
    const claims = Array.from({ length: 12 }, (_, index) => ({
      ...richClaim,
      claimId: `CLAIM-${index + 1}`,
      memberId: `MEMBER-${index + 1}`,
      providerId: `PROVIDER-${index + 1}`,
      diagnosisCode: index === 11 ? "SEARCH-DX" : "I10",
      member: index === 0 ? null : { ...richClaim.member, displayName: `Patient ${index + 1}` },
      provider: index === 0 ? null : { ...richClaim.provider, displayName: `Provider ${index + 1}` },
    }));
    render(<ClaimsView claims={claims} openClaim={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(10);
    expect(screen.getByText("Unknown patient")).toBeInTheDocument();
    expect(screen.getByText((content) => content === "Member ID: MEMBER-1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show more claims" }));
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(12);
    await userEvent.clear(screen.getByLabelText("Search claims"));
    await userEvent.type(screen.getByLabelText("Search claims"), "SEARCH-DX");
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(1);
    expect(screen.getByText("CLAIM-12")).toBeInTheDocument();
  });
});
