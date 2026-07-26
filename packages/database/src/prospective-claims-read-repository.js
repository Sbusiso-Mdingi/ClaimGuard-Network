import { createClaimsReadRepository as createLegacyClaimsReadRepository } from "./claims-read-repository.js";

const PROSPECTIVE_ANALYSIS_MODE = "PROSPECTIVE_CLAIM_SCREENING";

function probability(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function prospectiveRiskIndex(score) {
  const fraudProbability = probability(score?.fraudProbability);
  const threshold = probability(score?.threshold);
  if (fraudProbability === null || threshold === null) return null;
  if (threshold === 0) return 100;
  return Math.round(Math.min(100, 70 * fraudProbability / threshold) * 1_000) / 1_000;
}

function riskLevel(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 70) return "High";
  if (score >= 40) return "Medium";
  return "Low";
}

function percentage(value) {
  const parsed = probability(value);
  return parsed === null ? null : Math.round(parsed * 10_000) / 100;
}

function prospectiveEvidence(score) {
  const fraudProbability = percentage(score?.fraudProbability);
  const threshold = percentage(score?.threshold);
  if (fraudProbability === null) return [];
  const decision = score?.predictedClass || "UNKNOWN";
  const thresholdText = threshold === null
    ? ""
    : ` against a ${threshold.toFixed(2)}% fitted threshold`;
  return [
    `Prospective ML model classified the claim as ${decision} at ${fraudProbability.toFixed(2)}%${thresholdText}.`,
  ];
}

function mapProspectiveDetection(detection) {
  if (!detection || detection.analysisMode !== PROSPECTIVE_ANALYSIS_MODE) {
    return detection;
  }

  const score = detection.score && typeof detection.score === "object"
    ? detection.score
    : {};
  const riskScore = prospectiveRiskIndex(score);
  const reviewRecommended = score.reviewRecommended === true;
  const modelId = detection.modelId || detection.ensembleId || null;
  const modelVersion = detection.modelVersion || detection.ensembleVersion || null;

  return {
    ...detection,
    riskScore,
    riskScoreBasis: "THRESHOLD_NORMALIZED_BASELINE",
    riskLevel: riskLevel(riskScore),
    reviewRecommended,
    triggeredRules: reviewRecommended ? ["PROSPECTIVE_ML_REVIEW_RECOMMENDED"] : [],
    evidence: prospectiveEvidence(score),
    modelId,
    modelVersion,
    ensembleId: null,
    ensembleVersion: null,
  };
}

function mapClaim(claim) {
  if (!claim) return claim;
  const detection = mapProspectiveDetection(claim.detection);
  if (detection === claim.detection) return claim;

  const status = claim.investigation?.status
    || (detection.reviewRecommended ? "FLAGGED" : "SCORED");

  return {
    ...claim,
    status,
    riskScore: detection.riskScore,
    riskLevel: detection.riskLevel,
    triggeredRules: detection.triggeredRules,
    evidence: detection.evidence,
    detection,
  };
}

export function createClaimsReadRepository(pool, options) {
  const repository = createLegacyClaimsReadRepository(pool, options);
  return Object.freeze({
    async listClaims(params) {
      const result = await repository.listClaims(params);
      return {
        ...result,
        claims: result.claims.map(mapClaim),
      };
    },

    async getClaimById(claimId) {
      return mapClaim(await repository.getClaimById(claimId));
    },
  });
}
