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

export function createClaimIngestionRepository(pool) {
  return {
    async ingestClaims({ claims, source = "api" }) {
      if (!Array.isArray(claims) || claims.length === 0) {
        throw new Error("claims must be a non-empty array");
      }

      for (const claim of claims) {
        validateClaim(claim);
      }

      const connection = await pool.getConnection();
      let inserted = 0;
      let updated = 0;

      try {
        await connection.beginTransaction();

        for (const rawClaim of claims) {
          const claim = normalizeClaim(rawClaim);
          const [result] = await connection.execute(
            `
              INSERT INTO claims (
                claim_id, scheme_id, member_id, provider_id, service_date, billing_code, amount
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE
                scheme_id = VALUES(scheme_id),
                member_id = VALUES(member_id),
                provider_id = VALUES(provider_id),
                service_date = VALUES(service_date),
                billing_code = VALUES(billing_code),
                amount = VALUES(amount)
            `,
            [
              claim.claim_id,
              claim.scheme_id,
              claim.member_id,
              claim.provider_id,
              claim.service_date,
              claim.billing_code,
              claim.amount,
            ],
          );

          if (result?.affectedRows === 1) {
            inserted += 1;
          } else if (result?.affectedRows >= 2) {
            updated += 1;
          }
        }

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
      };
    },
  };
}
