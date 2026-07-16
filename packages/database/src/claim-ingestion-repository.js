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

export function createClaimIngestionRepository(pool, {
  maxOutboxAttempts = process.env.REPORT_WORKER_MAX_ATTEMPTS || process.env.CLAIM_OUTBOX_MAX_ATTEMPTS,
  dataPlaneContext = null,
  allowLegacyTenantContext = false,
} = {}) {
  if (!dataPlaneContext && !allowLegacyTenantContext) repositoryTenantId(null);
  const canonicalTenantId = () => repositoryTenantId(dataPlaneContext, { allowLegacyTenantContext });
  return {
    async ingestClaims({ claims, source = "api", correlationId = null }) {
      if (!Array.isArray(claims) || claims.length === 0) {
        throw new Error("claims must be a non-empty array");
      }

      for (const claim of claims) {
        validateClaim(claim);
      }

      const connection = await pool.getConnection();
      let inserted = 0;
      let updated = 0;
      let outboxJob = null;
      const tenantId = canonicalTenantId();

      try {
        await connection.beginTransaction();

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
              `
                UPDATE claims
                SET scheme_id = ?, member_id = ?, provider_id = ?, service_date = ?, billing_code = ?, amount = ?
                WHERE claim_id = ? AND tenant_id = ?
              `,
              [...claimValues, claim.claim_id, tenantId],
            );
            updated += 1;
          } else {
            try {
              await connection.execute(
                `
                  INSERT INTO claims (
                    claim_id, scheme_id, member_id, provider_id, service_date, billing_code, amount, tenant_id
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [claim.claim_id, ...claimValues, tenantId],
              );
            } catch (error) {
              if (error?.code !== "ER_DUP_ENTRY") {
                throw error;
              }

              const [racedOwnershipRows] = await connection.execute(
                "SELECT tenant_id FROM claims WHERE claim_id = ? FOR UPDATE",
                [claim.claim_id],
              );
              if (racedOwnershipRows?.[0]?.tenant_id !== tenantId) {
                throw new ClaimOwnershipConflictError();
              }
              await connection.execute(
                `
                  UPDATE claims
                  SET scheme_id = ?, member_id = ?, provider_id = ?, service_date = ?, billing_code = ?, amount = ?
                  WHERE claim_id = ? AND tenant_id = ?
                `,
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
        processing: {
          status: ["pending", "processing", "retry"].includes(outboxJob.status)
            ? "queued"
            : outboxJob.status,
          asynchronous: true,
          jobId: outboxJob.id,
          correlationId: outboxJob.correlationId,
          reused: !outboxJob.enqueued,
        },
      };
    },
  };
}
