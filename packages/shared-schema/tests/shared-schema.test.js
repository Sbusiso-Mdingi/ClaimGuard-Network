import assert from "node:assert/strict";
import test from "node:test";

import {
  backendHealthSchema,
  createClaimIngestionBatchSchema,
  createBackendHealth,
  createBackendInfo,
  trpcPingResponseSchema,
} from "../src/index.js";

const referenceBatch = () => ({
  source: "medical-aid-desktop",
  schemes: [{ scheme_id: "scheme-a", scheme_name: "Scheme A" }],
  members: [{
    member_id: "member-1",
    scheme_id: "scheme-a",
    first_name: "token:first",
    last_name: "token:last",
    date_of_birth: "1985-01-01",
    gender: "unspecified",
    identity_number: "token:identity",
    banking_detail: "token:member-bank",
    home_region: "Gauteng",
    home_lat: -26.2041,
    home_lon: 28.0473,
    join_date: "2020-01-01",
  }],
  providers: [{
    provider_id: "provider-1",
    scheme_id: "scheme-a",
    practice_number: "practice-1",
    specialty: "general-practitioner",
    practice_name: "Practice 1",
    banking_detail: "token:provider-bank",
    practice_region: "Gauteng",
    practice_lat: -26.2041,
    practice_lon: 28.0473,
    provider_kind: "INDIVIDUAL",
    provider_category: "GENERAL_PRACTITIONER",
  }],
  claims: [{
    claim_id: "claim-1",
    scheme_id: "scheme-a",
    member_id: "member-1",
    provider_id: "provider-1",
    service_date: "2026-07-19",
    received_date: "2026-07-20",
    billing_code: "CONSULT",
    amount: 450,
    quantity: 1,
    benefit_option: "COMPREHENSIVE",
    network_type: "IN_NETWORK",
    line_type: "PROFESSIONAL",
    tariff_discipline: "MEDICAL",
    diagnosis_code: "Z00.0",
    rendering_practitioner_id: null,
    rendering_practitioner_category: "NONE",
    rendering_known_to_billing_provider: false,
  }],
});

test("backend health payload validates", () => {
  const payload = createBackendHealth();

  assert.equal(payload.status, "ok");
  assert.equal(payload.service, "api");
  assert.equal(payload.phase, "3");
  backendHealthSchema.parse(payload);
});

test("backend info payload validates", () => {
  const payload = createBackendInfo();

  assert.equal(payload.service, "api");
  assert.equal(payload.phase, "3");
});

test("trpc ping response schema accepts backend ping data", () => {
  const payload = trpcPingResponseSchema.parse({
    service: "api",
    message: "pong",
  });

  assert.equal(payload.message, "pong");
});

test("claim ingestion contract accepts one complete authoritative batch", () => {
  const parsed = createClaimIngestionBatchSchema().parse(referenceBatch());
  assert.equal(parsed.claims[0].claim_id, "claim-1");
  assert.equal(parsed.members[0].identity_number, "token:identity");
});

test("claim ingestion contract rejects tenant spoofing and duplicate identifiers", () => {
  const spoofed = { ...referenceBatch(), tenant_id: "tenant-beta" };
  assert.equal(createClaimIngestionBatchSchema().safeParse(spoofed).success, false);

  const duplicated = referenceBatch();
  duplicated.claims.push({ ...duplicated.claims[0] });
  const duplicateResult = createClaimIngestionBatchSchema().safeParse(duplicated);
  assert.equal(duplicateResult.success, false);
  assert.match(duplicateResult.error.issues[0].message, /unique within an ingestion batch/i);
});

test("claim ingestion contract rejects embedded cross-scheme references", () => {
  const batch = referenceBatch();
  batch.claims[0].scheme_id = "scheme-b";
  const result = createClaimIngestionBatchSchema().safeParse(batch);
  assert.equal(result.success, false);
  assert.equal(result.error.issues.some((issue) => /same scheme/i.test(issue.message)), true);
});
