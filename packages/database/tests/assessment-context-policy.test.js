import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSESSMENT_IMPACT,
  AssessmentContextPolicyError,
  CORRECTION_IMPACT_CLASS,
  canonicalJson,
  changedFields,
  classifyCorrectionFields,
  publicMemberAssessmentPayload,
  publicProviderAssessmentPayload,
  sha256CanonicalJson,
} from "../src/assessment-context-policy.js";

test("canonical assessment JSON is deterministic and material changes alter SHA-256", () => {
  const left = { z: 3, a: { y: 2, x: 1 } };
  const right = { a: { x: 1, y: 2 }, z: 3 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(sha256CanonicalJson(left), sha256CanonicalJson(right));
  assert.notEqual(sha256CanonicalJson(left), sha256CanonicalJson({ ...left, z: 4 }));
  assert.match(sha256CanonicalJson(left), /^[0-9a-f]{64}$/);
});

test("changed field detection is canonical and stable", () => {
  assert.deepEqual(
    changedFields({ b: { y: 2, x: 1 }, a: 1 }, { a: 1, b: { x: 1, y: 2 }, c: 3 }),
    ["c"],
  );
});

test("member field policy derives model, identity and security impact server-side", () => {
  const model = classifyCorrectionFields("MEMBER", ["date_of_birth"]);
  assert.deepEqual(model.classifications, [CORRECTION_IMPACT_CLASS.MODEL_AFFECTING]);
  assert.equal(model.assessmentImpact, ASSESSMENT_IMPACT.REASSESSMENT_REQUIRED);
  assert.equal(model.requiresReplacementAssessment, true);

  const identity = classifyCorrectionFields("MEMBER", ["identity_number"]);
  assert.ok(identity.classifications.includes(CORRECTION_IMPACT_CLASS.IDENTITY_LINKAGE));
  assert.ok(identity.classifications.includes(CORRECTION_IMPACT_CLASS.NOTICE_AFFECTING));
  assert.equal(identity.assessmentImpact, ASSESSMENT_IMPACT.IDENTITY_REVIEW_REQUIRED);
  assert.equal(identity.requiresHumanReview, true);

  const security = classifyCorrectionFields("MEMBER", ["banking_detail"]);
  assert.deepEqual(security.classifications, [CORRECTION_IMPACT_CLASS.SECURITY_SENSITIVE]);
  assert.equal(security.assessmentImpact, ASSESSMENT_IMPACT.SECURITY_REVIEW_REQUIRED);
});

test("provider display-only changes do not automatically reassess", () => {
  const result = classifyCorrectionFields("PROVIDER", ["practice_name"]);
  assert.deepEqual(result.classifications, [CORRECTION_IMPACT_CLASS.DISPLAY_ONLY]);
  assert.equal(result.assessmentImpact, ASSESSMENT_IMPACT.NO_REASSESSMENT);
  assert.equal(result.requiresReplacementAssessment, false);
});

test("unknown fields fail closed and stable identity changes are prohibited", () => {
  const unknown = classifyCorrectionFields("PROVIDER", ["new_unclassified_field"]);
  assert.equal(unknown.requiresHumanReview, true);
  assert.equal(unknown.requiresReplacementAssessment, true);
  assert.deepEqual(unknown.unknownFields, ["new_unclassified_field"]);

  assert.throws(
    () => classifyCorrectionFields("MEMBER", ["scheme_id"]),
    (error) => error instanceof AssessmentContextPolicyError
      && error.code === "CORRECTION_STABLE_IDENTITY_CHANGE_PROHIBITED",
  );
});

test("generic assessment payloads exclude banking detail", () => {
  const member = publicMemberAssessmentPayload({
    member_id: "MEM-1", member_version: 2, scheme_id: "SCH-1",
    first_name: "A", last_name: "B", date_of_birth: "1990-01-01", gender: "X",
    identity_number: "ID-1", banking_detail: "SECRET-MEMBER-BANK",
    home_region: "R", home_lat: -29.1, home_lon: 26.2, join_date: "2020-01-01",
  });
  const provider = publicProviderAssessmentPayload({
    provider_id: "PRO-1", provider_version: 3, scheme_id: "SCH-1",
    practice_number: "P1", specialty: "GENERAL", practice_name: "Practice",
    banking_detail: "SECRET-PROVIDER-BANK", practice_region: "R",
    practice_lat: -29.1, practice_lon: 26.2,
    provider_kind: "PRACTICE", provider_category: "GENERAL",
  });
  assert.equal(Object.hasOwn(member, "banking_detail"), false);
  assert.equal(Object.hasOwn(provider, "banking_detail"), false);
  assert.doesNotMatch(JSON.stringify({ member, provider }), /SECRET-(?:MEMBER|PROVIDER)-BANK/);
});
