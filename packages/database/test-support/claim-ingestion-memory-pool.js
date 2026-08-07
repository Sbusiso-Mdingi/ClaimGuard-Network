const FIXED_DATABASE_TIMESTAMP = "2026-07-23 12:30:45.123";

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function cloneMap(map) {
  return new Map([...map].map(([key, value]) => [
    key,
    value && typeof value === "object" ? { ...value } : value,
  ]));
}

function replaceMap(target, source) {
  target.clear();
  for (const [key, value] of source) {
    target.set(key, value && typeof value === "object" ? { ...value } : value);
  }
}

export function createClaimIngestionMemoryPool({
  tenantId = "tenant_default",
  seedReferences = true,
  activeStrategy = {
    id: 1,
    strategy_type: "deterministic_rules",
    model_deployment_id: null,
  },
  failClaimInsert = false,
  failOutboxInsert = false,
} = {}) {
  const executions = [];
  const references = {
    schemes: new Map(),
    members: new Map(),
    providers: new Map(),
  };
  const medicalSchemes = new Map();
  const memberVersions = new Map();
  const providerVersions = new Map();
  const assessments = new Map();
  const claims = new Map();
  const claimVersions = new Map();
  const outbox = new Map();
  let rollbackCount = 0;
  let commitCount = 0;

  const claimVersionKey = (recordTenantId, claimId, version) =>
    `${recordTenantId}:${claimId}:${version}`;
  const memberVersionKey = (recordTenantId, memberId, version) =>
    `${recordTenantId}:${memberId}:${version}`;
  const providerVersionKey = (recordTenantId, providerId, version) =>
    `${recordTenantId}:${providerId}:${version}`;
  const outboxKey = (recordTenantId, key) => `${recordTenantId}:${key}`;
  const medicalSchemeKey = (recordTenantId, schemeId) => `${recordTenantId}:${schemeId}`;

  if (seedReferences) {
    references.schemes.set("scheme_a", { tenant_id: tenantId });
    const member = {
      tenant_id: tenantId,
      member_id: "M-1",
      current_member_version: 1,
      scheme_id: "scheme_a",
      first_name: "Seed",
      last_name: "Member",
      date_of_birth: "1985-01-01",
      gender: "unspecified",
      identity_number: "token:seed-member",
      banking_detail: "token:seed-member-bank",
      home_region: "Gauteng",
      home_lat: -26.2,
      home_lon: 28,
      join_date: "2020-01-01",
    };
    const provider = {
      tenant_id: tenantId,
      provider_id: "P-1",
      current_provider_version: 1,
      scheme_id: "scheme_a",
      practice_number: "practice-seed",
      specialty: "GP",
      practice_name: "Seed Practice",
      banking_detail: "token:seed-provider-bank",
      practice_region: "Gauteng",
      practice_lat: -26.2,
      practice_lon: 28,
      provider_kind: "INDIVIDUAL",
      provider_category: "GENERAL_PRACTITIONER",
    };
    references.members.set(member.member_id, member);
    references.providers.set(provider.provider_id, provider);
    memberVersions.set(memberVersionKey(tenantId, member.member_id, 1), {
      ...member,
      member_version: 1,
    });
    providerVersions.set(providerVersionKey(tenantId, provider.provider_id, 1), {
      ...provider,
      provider_version: 1,
    });
  }

  function findOutboxById(id) {
    return [...outbox.values()].find((row) => row.id === id) || null;
  }

  function deleteOutboxById(id) {
    for (const [key, row] of outbox) {
      if (row.id === id) {
        outbox.delete(key);
        return row;
      }
    }
    return null;
  }

  const pool = {
    executions,
    references,
    medicalSchemes,
    memberVersions,
    providerVersions,
    assessments,
    claims,
    claimVersions,
    outbox,
    get rollbackCount() { return rollbackCount; },
    get commitCount() { return commitCount; },

    setReferenceTenant(nextTenantId) {
      for (const map of [references.schemes, references.members, references.providers]) {
        for (const row of map.values()) row.tenant_id = nextTenantId;
      }
    },

    async getConnection() {
      let snapshot = null;
      return {
        async beginTransaction() {
          snapshot = {
            references: {
              schemes: cloneMap(references.schemes),
              members: cloneMap(references.members),
              providers: cloneMap(references.providers),
            },
            medicalSchemes: cloneMap(medicalSchemes),
            memberVersions: cloneMap(memberVersions),
            providerVersions: cloneMap(providerVersions),
            assessments: cloneMap(assessments),
            claims: cloneMap(claims),
            claimVersions: cloneMap(claimVersions),
            outbox: cloneMap(outbox),
          };
        },

        async execute(sql, params = []) {
          const statement = normalizeSql(sql);
          executions.push({ sql: statement, params });

          if (statement.includes("FROM detection_strategies")) {
            return [activeStrategy ? [{ ...activeStrategy }] : []];
          }

          if (statement.includes("UTC_TIMESTAMP(3) AS context_cutoff_at")) {
            return [[{ context_cutoff_at: FIXED_DATABASE_TIMESTAMP }]];
          }

          if (statement.includes("FROM claims c") && statement.includes("LEFT JOIN claim_versions cv")) {
            const current = claims.get(params[0]);
            if (!current) return [[]];
            const version = claimVersions.get(claimVersionKey(
              current.tenant_id,
              params[0],
              current.current_claim_version,
            ));
            return [[{
              tenant_id: current.tenant_id,
              current_claim_version: current.current_claim_version,
              payload_hash: version?.payload_hash || null,
              claim_payload: version?.claim_payload || null,
            }]];
          }

          if (statement.startsWith(
            "SELECT claim_id, claim_version, member_id, provider_id, claim_payload FROM claim_versions",
          )) {
            const row = claimVersions.get(claimVersionKey(params[0], params[1], params[2]));
            return [row ? [{ ...row }] : []];
          }

          if (statement.includes("FROM member_versions mv")) {
            const member = references.members.get(params[1]);
            const version = params[2] ?? member?.current_member_version;
            const row = memberVersions.get(memberVersionKey(params[0], params[1], version));
            return [row ? [{ ...row }] : []];
          }

          if (statement.includes("FROM provider_versions pv")) {
            const provider = references.providers.get(params[1]);
            const version = params[2] ?? provider?.current_provider_version;
            const row = providerVersions.get(providerVersionKey(params[0], params[1], version));
            return [row ? [{ ...row }] : []];
          }

          const referenceSelect = statement.match(/FROM (schemes|members|providers) WHERE/i);
          if (referenceSelect) {
            const row = references[referenceSelect[1].toLowerCase()].get(params[0]);
            return [row ? [{ ...row }] : []];
          }

          if (statement.startsWith("INSERT INTO schemes")) {
            references.schemes.set(params[0], { tenant_id: params.at(-1) });
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("INSERT INTO medical_schemes")) {
            const [recordTenantId, schemeId, schemeName] = params;
            const scheme = references.schemes.get(schemeId);
            if (!scheme || scheme.tenant_id !== recordTenantId) {
              throw new Error("medical_schemes references an unknown tenant scheme");
            }
            medicalSchemes.set(medicalSchemeKey(recordTenantId, schemeId), {
              tenant_id: recordTenantId,
              scheme_id: schemeId,
              scheme_name: schemeName,
              is_primary: 1,
            });
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("INSERT INTO members")) {
            const [
              memberId, schemeId, firstName, lastName, dateOfBirth, gender,
              identityNumber, bankingDetail, homeRegion, homeLat, homeLon,
              joinDate, recordTenantId,
            ] = params;
            references.members.set(memberId, {
              tenant_id: recordTenantId,
              member_id: memberId,
              current_member_version: 1,
              scheme_id: schemeId,
              first_name: firstName,
              last_name: lastName,
              date_of_birth: dateOfBirth,
              gender,
              identity_number: identityNumber,
              banking_detail: bankingDetail,
              home_region: homeRegion,
              home_lat: homeLat,
              home_lon: homeLon,
              join_date: joinDate,
            });
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("INSERT INTO providers")) {
            const [
              providerId, schemeId, practiceNumber, specialty, practiceName,
              bankingDetail, practiceRegion, practiceLat, practiceLon,
              providerKind, providerCategory, recordTenantId,
            ] = params;
            references.providers.set(providerId, {
              tenant_id: recordTenantId,
              provider_id: providerId,
              current_provider_version: 1,
              scheme_id: schemeId,
              practice_number: practiceNumber,
              specialty,
              practice_name: practiceName,
              banking_detail: bankingDetail,
              practice_region: practiceRegion,
              practice_lat: practiceLat,
              practice_lon: practiceLon,
              provider_kind: providerKind,
              provider_category: providerCategory,
            });
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("INSERT INTO member_versions")) {
            const [
              recordTenantId, memberId, schemeId, firstName, lastName,
              dateOfBirth, gender, identityNumber, bankingDetail, homeRegion,
              homeLat, homeLon, joinDate, versionReason, sourceReference,
              createdBy, payloadHash,
            ] = params;
            memberVersions.set(memberVersionKey(recordTenantId, memberId, 1), {
              tenant_id: recordTenantId,
              member_id: memberId,
              member_version: 1,
              scheme_id: schemeId,
              first_name: firstName,
              last_name: lastName,
              date_of_birth: dateOfBirth,
              gender,
              identity_number: identityNumber,
              banking_detail: bankingDetail,
              home_region: homeRegion,
              home_lat: homeLat,
              home_lon: homeLon,
              join_date: joinDate,
              version_reason: versionReason,
              source_reference: sourceReference,
              created_by: createdBy,
              payload_hash: payloadHash,
            });
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("INSERT INTO provider_versions")) {
            const [
              recordTenantId, providerId, schemeId, practiceNumber, specialty,
              practiceName, bankingDetail, practiceRegion, practiceLat,
              practiceLon, providerKind, providerCategory, versionReason,
              sourceReference, createdBy, payloadHash,
            ] = params;
            providerVersions.set(providerVersionKey(recordTenantId, providerId, 1), {
              tenant_id: recordTenantId,
              provider_id: providerId,
              provider_version: 1,
              scheme_id: schemeId,
              practice_number: practiceNumber,
              specialty,
              practice_name: practiceName,
              banking_detail: bankingDetail,
              practice_region: practiceRegion,
              practice_lat: practiceLat,
              practice_lon: practiceLon,
              provider_kind: providerKind,
              provider_category: providerCategory,
              version_reason: versionReason,
              source_reference: sourceReference,
              created_by: createdBy,
              payload_hash: payloadHash,
            });
            return [{ affectedRows: 1 }];
          }

          if (
            statement.startsWith("UPDATE schemes")
            || statement.startsWith("UPDATE members")
            || statement.startsWith("UPDATE providers")
          ) {
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("INSERT INTO claims")) {
            if (failClaimInsert) throw new Error("claim insert failed");
            const [
              claimId, schemeId, memberId, providerId, serviceDate,
              receivedDate, billingCode, amount, quantity, benefitOption,
              networkType, lineType, tariffDiscipline, diagnosisCode,
              renderingPractitionerId, renderingPractitionerCategory,
              renderingKnownToBillingProvider, claimTenantId,
            ] = params;
            if (claims.has(claimId)) {
              const error = new Error("duplicate claim");
              error.code = "ER_DUP_ENTRY";
              throw error;
            }
            claims.set(claimId, {
              claim_id: claimId,
              current_claim_version: 1,
              scheme_id: schemeId,
              member_id: memberId,
              provider_id: providerId,
              service_date: serviceDate,
              received_date: receivedDate,
              billing_code: billingCode,
              amount,
              quantity,
              benefit_option: benefitOption,
              network_type: networkType,
              line_type: lineType,
              tariff_discipline: tariffDiscipline,
              diagnosis_code: diagnosisCode,
              rendering_practitioner_id: renderingPractitionerId,
              rendering_practitioner_category: renderingPractitionerCategory,
              rendering_known_to_billing_provider: renderingKnownToBillingProvider,
              tenant_id: claimTenantId,
            });
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("INSERT INTO claim_versions")) {
            const [
              recordTenantId, claimId, claimVersion, schemeId, memberId,
              providerId, serviceDate, receivedDate, billingCode, amount,
              claimPayload, payloadHash, versionReason,
            ] = params;
            claimVersions.set(claimVersionKey(recordTenantId, claimId, claimVersion), {
              tenant_id: recordTenantId,
              claim_id: claimId,
              claim_version: claimVersion,
              scheme_id: schemeId,
              member_id: memberId,
              provider_id: providerId,
              service_date: serviceDate,
              received_date: receivedDate,
              billing_code: billingCode,
              amount,
              claim_payload: claimPayload,
              payload_hash: payloadHash,
              version_reason: versionReason,
            });
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("UPDATE claim_versions SET payload_hash")) {
            const [payloadHash, recordTenantId, claimId, claimVersion] = params;
            const row = claimVersions.get(claimVersionKey(recordTenantId, claimId, claimVersion));
            if (row) row.payload_hash = payloadHash;
            return [{ affectedRows: row ? 1 : 0 }];
          }

          if (statement.startsWith("UPDATE claims SET current_claim_version")) {
            const nextVersion = params[0];
            const claimValues = params.slice(1, 17);
            const claimId = params[17];
            const claimTenantId = params[18];
            const expectedVersion = params[19];
            const current = claims.get(claimId);
            if (
              !current
              || current.tenant_id !== claimTenantId
              || current.current_claim_version !== expectedVersion
            ) return [{ affectedRows: 0 }];
            const [
              schemeId, memberId, providerId, serviceDate, receivedDate,
              billingCode, amount, quantity, benefitOption, networkType,
              lineType, tariffDiscipline, diagnosisCode,
              renderingPractitionerId, renderingPractitionerCategory,
              renderingKnownToBillingProvider,
            ] = claimValues;
            claims.set(claimId, {
              ...current,
              current_claim_version: nextVersion,
              scheme_id: schemeId,
              member_id: memberId,
              provider_id: providerId,
              service_date: serviceDate,
              received_date: receivedDate,
              billing_code: billingCode,
              amount,
              quantity,
              benefit_option: benefitOption,
              network_type: networkType,
              line_type: lineType,
              tariff_discipline: tariffDiscipline,
              diagnosis_code: diagnosisCode,
              rendering_practitioner_id: renderingPractitionerId,
              rendering_practitioner_category: renderingPractitionerCategory,
              rendering_known_to_billing_provider: renderingKnownToBillingProvider,
            });
            return [{ affectedRows: 1 }];
          }

          if (
            statement.startsWith("INSERT INTO claim_processing_outbox")
            && !statement.includes("id, assessment_id, tenant_id")
          ) {
            if (failOutboxInsert) throw new Error("outbox insert failed");
            const [
              id, recordTenantId, jobType, aggregateType, aggregateId,
              correlationId, idempotencyKey, payload, maxAttempts,
              detectionStrategyId, strategyType, modelDeploymentId,
            ] = params;
            const key = outboxKey(recordTenantId, idempotencyKey);
            if (!outbox.has(key)) {
              outbox.set(key, {
                id,
                assessment_id: null,
                tenant_id: recordTenantId,
                job_type: jobType,
                aggregate_type: aggregateType,
                aggregate_id: aggregateId,
                correlation_id: correlationId,
                idempotency_key: idempotencyKey,
                payload,
                status: "pending",
                attempt_count: 0,
                max_attempts: maxAttempts,
                detection_strategy_id: detectionStrategyId,
                strategy_type: strategyType,
                model_deployment_id: modelDeploymentId,
              });
              return [{ affectedRows: 1 }];
            }
            return [{ affectedRows: 0 }];
          }

          if (statement.startsWith(
            "SELECT id, assessment_id, tenant_id, correlation_id, payload, detection_strategy_id, strategy_type, model_deployment_id FROM claim_processing_outbox WHERE id = ? LIMIT 1 FOR UPDATE",
          )) {
            const row = findOutboxById(params[0]);
            return [row ? [{ ...row }] : []];
          }

          if (statement.startsWith(
            "DELETE FROM claim_processing_outbox WHERE id = ? AND tenant_id = ? AND assessment_id IS NULL",
          )) {
            const row = findOutboxById(params[0]);
            if (!row || row.tenant_id !== params[1] || row.assessment_id !== null) {
              return [{ affectedRows: 0 }];
            }
            deleteOutboxById(params[0]);
            return [{ affectedRows: 1 }];
          }

          if (statement.startsWith("INSERT INTO assessment_versions")) {
            const [
              assessmentId, recordTenantId, claimId, claimVersion, memberId,
              memberVersion, providerId, providerVersion, detectionStrategyId,
              strategyType, modelDeploymentId, modelOrRuleVersion,
              featureSchemaVersion, referenceDataVersion, inputSnapshot,
              inputHash, assessmentReason, supersedesAssessmentId,
              sourceCorrectionEventId, createdBy,
            ] = params;
            assessments.set(assessmentId, {
              assessment_id: assessmentId,
              tenant_id: recordTenantId,
              claim_id: claimId,
              claim_version: claimVersion,
              member_id: memberId,
              member_version: memberVersion,
              provider_id: providerId,
              provider_version: providerVersion,
              detection_strategy_id: detectionStrategyId,
              strategy_type: strategyType,
              model_deployment_id: modelDeploymentId,
              model_or_rule_version: modelOrRuleVersion,
              feature_schema_version: featureSchemaVersion,
              reference_data_version: referenceDataVersion,
              input_snapshot: inputSnapshot,
              input_hash: inputHash,
              assessment_reason: assessmentReason,
              supersedes_assessment_id: supersedesAssessmentId,
              source_correction_event_id: sourceCorrectionEventId,
              provenance_status: "COMPLETE",
              created_by: createdBy,
            });
            return [{ affectedRows: 1 }];
          }

          if (
            statement.startsWith("INSERT INTO claim_processing_outbox")
            && statement.includes("id, assessment_id, tenant_id")
          ) {
            if (failOutboxInsert) throw new Error("outbox insert failed");
            const [
              id, assessmentId, recordTenantId, aggregateId, correlationId,
              idempotencyKey, payload, maxAttempts, detectionStrategyId,
              strategyType, modelDeploymentId,
            ] = params;
            const key = outboxKey(recordTenantId, idempotencyKey);
            if (!outbox.has(key)) {
              outbox.set(key, {
                id,
                assessment_id: assessmentId,
                tenant_id: recordTenantId,
                job_type: "claim_detection",
                aggregate_type: "claim_batch",
                aggregate_id: aggregateId,
                correlation_id: correlationId,
                idempotency_key: idempotencyKey,
                payload,
                status: "pending",
                attempt_count: 0,
                max_attempts: maxAttempts,
                detection_strategy_id: detectionStrategyId,
                strategy_type: strategyType,
                model_deployment_id: modelDeploymentId,
              });
              return [{ affectedRows: 1 }];
            }
            return [{ affectedRows: 0 }];
          }

          if (
            statement.includes("FROM claim_processing_outbox")
            && statement.includes("idempotency_key = ?")
          ) {
            const row = outbox.get(outboxKey(params[0], params[1]));
            return [row ? [{ ...row }] : []];
          }

          throw new Error(`Unexpected SQL: ${statement}`);
        },

        async commit() {
          commitCount += 1;
          snapshot = null;
        },

        async rollback() {
          rollbackCount += 1;
          if (!snapshot) return;
          replaceMap(references.schemes, snapshot.references.schemes);
          replaceMap(references.members, snapshot.references.members);
          replaceMap(references.providers, snapshot.references.providers);
          replaceMap(medicalSchemes, snapshot.medicalSchemes);
          replaceMap(memberVersions, snapshot.memberVersions);
          replaceMap(providerVersions, snapshot.providerVersions);
          replaceMap(assessments, snapshot.assessments);
          replaceMap(claims, snapshot.claims);
          replaceMap(claimVersions, snapshot.claimVersions);
          replaceMap(outbox, snapshot.outbox);
        },

        release() {},
      };
    },
  };

  return pool;
}
