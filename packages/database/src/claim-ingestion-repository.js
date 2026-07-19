import { enqueueClaimProcessingJob } from "./claim-processing-outbox-repository.js";
import { repositoryTenantId } from "./repository-context.js";

export class ClaimOwnershipConflictError extends Error {
  constructor(message = "Claim identifier is already owned by another tenant.") {
    super(message);
    this.name = "ClaimOwnershipConflictError";
    this.code = "CLAIM_OWNERSHIP_CONFLICT";
    this.status = 409;
  }
}

export class ReferenceOwnershipConflictError extends Error {
  constructor(entityType, entityId) {
    super(`${entityType} identifier ${entityId} is already owned by another tenant.`);
    this.name = "ReferenceOwnershipConflictError";
    this.code = "REFERENCE_OWNERSHIP_CONFLICT";
    this.status = 409;
  }
}

export class ClaimReferenceValidationError extends Error {
  constructor(entityType, entityId) {
    super(`${entityType} identifier ${entityId} is not valid for the authenticated tenant and scheme.`);
    this.name = "ClaimReferenceValidationError";
    this.code = "CLAIM_REFERENCE_INVALID";
    this.status = 422;
  }
}

function normalizeClaim(claim) {
  return {
    claim_id: claim.claim_id,
    scheme_id: claim.scheme_id,
    member_id: claim.member_id,
    provider_id: claim.provider_id,
    service_date: claim.service_date,
    billing_code: claim.billing_code,
    amount: claim.amount,
  };
}

function validateClaim(claim) {
  const requiredFields = [
    "claim_id",
    "scheme_id",
    "member_id",
    "provider_id",
    "service_date",
    "billing_code",
    "amount",
  ];
  const missing = requiredFields.filter((field) => claim[field] === undefined || claim[field] === null || claim[field] === "");
  if (missing.length > 0) {
    throw new Error(`Claim ${claim.claim_id || "<unknown>"} is missing required fields: ${missing.join(", ")}`);
  }
}

function outboxClaim(rawClaim) {
  const { tenant_id: _untrustedTenantId, ...claim } = rawClaim;
  return claim;
}

function configuredMaxAttempts(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5;
}

function emptyWriteSummary(received = 0) {
  return { received, inserted: 0, updated: 0 };
}

async function readOwner(connection, tableName, idColumn, entityId) {
  const [rows] = await connection.execute(
    `SELECT tenant_id FROM ${tableName} WHERE ${idColumn} = ? FOR UPDATE`,
    [entityId],
  );
  return rows?.[0]?.tenant_id ?? null;
}

function referenceCacheKey(tableName, entityId, schemeId = null) {
  return `${tableName}:${entityId}:${schemeId || ""}`;
}

async function assertTenantReference(connection, {
  tableName,
  idColumn,
  entityType,
  entityId,
  tenantId,
  schemeId = null,
  cache,
}) {
  const cacheKey = referenceCacheKey(tableName, entityId, schemeId);
  if (cache.has(cacheKey)) return;

  const selectedColumns = schemeId === null ? "tenant_id" : "tenant_id, scheme_id";
  const [rows] = await connection.execute(
    `SELECT ${selectedColumns} FROM ${tableName} WHERE ${idColumn} = ? FOR UPDATE`,
    [entityId],
  );
  const record = rows?.[0] || null;
  if (!record || record.tenant_id !== tenantId || (schemeId !== null && record.scheme_id !== schemeId)) {
    throw new ClaimReferenceValidationError(entityType, entityId);
  }
  cache.add(cacheKey);
}

async function upsertTenantOwnedRecord(connection, {
  tableName,
  idColumn,
  entityType,
  entityId,
  tenantId,
  insertSql,
  insertParams,
  updateSql,
  updateParams,
}) {
  const existingOwner = await readOwner(connection, tableName, idColumn, entityId);
  if (existingOwner && existingOwner !== tenantId) {
    throw new ReferenceOwnershipConflictError(entityType, entityId);
  }
  if (existingOwner) {
    await connection.execute(updateSql, [...updateParams, entityId, tenantId]);
    return "updated";
  }

  try {
    await connection.execute(insertSql, [...insertParams, tenantId]);
    return "inserted";
  } catch (error) {
    if (error?.code !== "ER_DUP_ENTRY") throw error;
    const racedOwner = await readOwner(connection, tableName, idColumn, entityId);
    if (racedOwner !== tenantId) {
      throw new ReferenceOwnershipConflictError(entityType, entityId);
    }
    await connection.execute(updateSql, [...updateParams, entityId, tenantId]);
    return "updated";
  }
}

function recordWrite(summary, result) {
  summary[result] += 1;
}

async function ingestReferenceData(connection, { schemes, members, providers, tenantId, referenceCache }) {
  const summary = {
    schemes: emptyWriteSummary(schemes.length),
    members: emptyWriteSummary(members.length),
    providers: emptyWriteSummary(providers.length),
  };

  for (const scheme of schemes) {
    const result = await upsertTenantOwnedRecord(connection, {
      tableName: "schemes",
      idColumn: "scheme_id",
      entityType: "Scheme",
      entityId: scheme.scheme_id,
      tenantId,
      insertSql: "INSERT INTO schemes (scheme_id, scheme_name, tenant_id) VALUES (?, ?, ?)",
      insertParams: [scheme.scheme_id, scheme.scheme_name],
      updateSql: "UPDATE schemes SET scheme_name = ? WHERE scheme_id = ? AND tenant_id = ?",
      updateParams: [scheme.scheme_name],
    });
    recordWrite(summary.schemes, result);
    referenceCache.add(referenceCacheKey("schemes", scheme.scheme_id));
    await connection.execute(
      `INSERT INTO medical_schemes (tenant_id, scheme_id, scheme_name, is_primary)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE scheme_name = VALUES(scheme_name)`,
      [tenantId, scheme.scheme_id, scheme.scheme_name],
    );
  }

  for (const member of members) {
    await assertTenantReference(connection, {
      tableName: "schemes",
      idColumn: "scheme_id",
      entityType: "Scheme",
      entityId: member.scheme_id,
      tenantId,
      cache: referenceCache,
    });
    const values = [
      member.scheme_id,
      member.first_name,
      member.last_name,
      member.date_of_birth,
      member.gender,
      member.identity_number,
      member.banking_detail,
      member.home_region,
      member.home_lat,
      member.home_lon,
      member.join_date,
    ];
    const result = await upsertTenantOwnedRecord(connection, {
      tableName: "members",
      idColumn: "member_id",
      entityType: "Member",
      entityId: member.member_id,
      tenantId,
      insertSql: `INSERT INTO members (
        member_id, scheme_id, first_name, last_name, date_of_birth, gender,
        identity_number, banking_detail, home_region, home_lat, home_lon, join_date, tenant_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      insertParams: [member.member_id, ...values],
      updateSql: `UPDATE members SET
        scheme_id = ?, first_name = ?, last_name = ?, date_of_birth = ?, gender = ?,
        identity_number = ?, banking_detail = ?, home_region = ?, home_lat = ?, home_lon = ?, join_date = ?
        WHERE member_id = ? AND tenant_id = ?`,
      updateParams: values,
    });
    recordWrite(summary.members, result);
    referenceCache.add(referenceCacheKey("members", member.member_id, member.scheme_id));
  }

  for (const provider of providers) {
    await assertTenantReference(connection, {
      tableName: "schemes",
      idColumn: "scheme_id",
      entityType: "Scheme",
      entityId: provider.scheme_id,
      tenantId,
      cache: referenceCache,
    });
    const values = [
      provider.scheme_id,
      provider.practice_number,
      provider.specialty,
      provider.practice_name,
      provider.banking_detail,
      provider.practice_region,
      provider.practice_lat,
      provider.practice_lon,
    ];
    const result = await upsertTenantOwnedRecord(connection, {
      tableName: "providers",
      idColumn: "provider_id",
      entityType: "Provider",
      entityId: provider.provider_id,
      tenantId,
      insertSql: `INSERT INTO providers (
        provider_id, scheme_id, practice_number, specialty, practice_name,
        banking_detail, practice_region, practice_lat, practice_lon, tenant_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      insertParams: [provider.provider_id, ...values],
      updateSql: `UPDATE providers SET
        scheme_id = ?, practice_number = ?, specialty = ?, practice_name = ?,
        banking_detail = ?, practice_region = ?, practice_lat = ?, practice_lon = ?
        WHERE provider_id = ? AND tenant_id = ?`,
      updateParams: values,
    });
    recordWrite(summary.providers, result);
    referenceCache.add(referenceCacheKey("providers", provider.provider_id, provider.scheme_id));
  }

  return summary;
}

export function createClaimIngestionRepository(pool, {
  maxOutboxAttempts = process.env.REPORT_WORKER_MAX_ATTEMPTS || process.env.CLAIM_OUTBOX_MAX_ATTEMPTS,
  dataPlaneContext = null,
  allowLegacyTenantContext = false,
} = {}) {
  if (!dataPlaneContext && !allowLegacyTenantContext) repositoryTenantId(null);
  const canonicalTenantId = () => repositoryTenantId(dataPlaneContext, { allowLegacyTenantContext });

  return {
    async ingestClaims({
      claims,
      schemes = [],
      members = [],
      providers = [],
      source = "api",
      correlationId = null,
    }) {
      if (!Array.isArray(claims) || claims.length === 0) {
        throw new Error("claims must be a non-empty array");
      }
      if (![schemes, members, providers].every(Array.isArray)) {
        throw new Error("schemes, members, and providers must be arrays");
      }
      for (const claim of claims) validateClaim(claim);

      const connection = await pool.getConnection();
      let inserted = 0;
      let updated = 0;
      let outboxJob = null;
      let referenceData = null;
      const tenantId = canonicalTenantId();
      const referenceCache = new Set();

      try {
        await connection.beginTransaction();
        referenceData = await ingestReferenceData(connection, {
          schemes,
          members,
          providers,
          tenantId,
          referenceCache,
        });

        for (const rawClaim of claims) {
          const claim = normalizeClaim(rawClaim);
          const [ownershipRows] = await connection.execute(
            "SELECT tenant_id FROM claims WHERE claim_id = ? FOR UPDATE",
            [claim.claim_id],
          );
          const existingTenantId = ownershipRows?.[0]?.tenant_id ?? null;
          if (ownershipRows?.length > 0 && existingTenantId !== tenantId) {
            throw new ClaimOwnershipConflictError();
          }

          await assertTenantReference(connection, {
            tableName: "schemes",
            idColumn: "scheme_id",
            entityType: "Scheme",
            entityId: claim.scheme_id,
            tenantId,
            cache: referenceCache,
          });
          await assertTenantReference(connection, {
            tableName: "members",
            idColumn: "member_id",
            entityType: "Member",
            entityId: claim.member_id,
            tenantId,
            schemeId: claim.scheme_id,
            cache: referenceCache,
          });
          await assertTenantReference(connection, {
            tableName: "providers",
            idColumn: "provider_id",
            entityType: "Provider",
            entityId: claim.provider_id,
            tenantId,
            schemeId: claim.scheme_id,
            cache: referenceCache,
          });

          const claimValues = [
            claim.scheme_id,
            claim.member_id,
            claim.provider_id,
            claim.service_date,
            claim.billing_code,
            claim.amount,
          ];

          if (ownershipRows?.length > 0) {
            await connection.execute(
              `UPDATE claims
               SET scheme_id = ?, member_id = ?, provider_id = ?, service_date = ?, billing_code = ?, amount = ?
               WHERE claim_id = ? AND tenant_id = ?`,
              [...claimValues, claim.claim_id, tenantId],
            );
            updated += 1;
          } else {
            try {
              await connection.execute(
                `INSERT INTO claims (
                  claim_id, scheme_id, member_id, provider_id, service_date, billing_code, amount, tenant_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [claim.claim_id, ...claimValues, tenantId],
              );
            } catch (error) {
              if (error?.code !== "ER_DUP_ENTRY") throw error;
              const [racedOwnershipRows] = await connection.execute(
                "SELECT tenant_id FROM claims WHERE claim_id = ? FOR UPDATE",
                [claim.claim_id],
              );
              if (racedOwnershipRows?.[0]?.tenant_id !== tenantId) {
                throw new ClaimOwnershipConflictError();
              }
              await connection.execute(
                `UPDATE claims
                 SET scheme_id = ?, member_id = ?, provider_id = ?, service_date = ?, billing_code = ?, amount = ?
                 WHERE claim_id = ? AND tenant_id = ?`,
                [...claimValues, claim.claim_id, tenantId],
              );
              updated += 1;
              continue;
            }
            inserted += 1;
          }
        }

        outboxJob = await enqueueClaimProcessingJob(connection, {
          tenantId,
          claims: claims.map(outboxClaim),
          source,
          correlationId: correlationId || undefined,
          maxAttempts: configuredMaxAttempts(maxOutboxAttempts),
        });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      return {
        received: claims.length,
        inserted,
        updated,
        source,
        referenceData,
        processing: {
          status: ["pending", "processing", "retry"].includes(outboxJob.status) ? "queued" : outboxJob.status,
          asynchronous: true,
          jobId: outboxJob.id,
          correlationId: outboxJob.correlationId,
          reused: !outboxJob.enqueued,
        },
      };
    },
  };
}
