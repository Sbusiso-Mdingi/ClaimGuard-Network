async function insertBaselineClaim(
  pool,
  claim,
) {
  await pool.execute(
    `
      INSERT INTO claims (
        claim_id,
        current_claim_version,
        scheme_id,
        member_id,
        provider_id,
        service_date,
        received_date,
        billing_code,
        amount,
        quantity,
        benefit_option,
        network_type,
        line_type,
        tariff_discipline,
        diagnosis_code,
        rendering_practitioner_id,
        rendering_practitioner_category,
        rendering_known_to_billing_provider,
        tenant_id
      )
      VALUES (
        ?,
        1,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      )
      ON DUPLICATE KEY UPDATE
        current_claim_version =
          VALUES(current_claim_version),
        scheme_id =
          VALUES(scheme_id),
        member_id =
          VALUES(member_id),
        provider_id =
          VALUES(provider_id),
        service_date =
          VALUES(service_date),
        received_date =
          VALUES(received_date),
        billing_code =
          VALUES(billing_code),
        amount =
          VALUES(amount),
        quantity =
          VALUES(quantity),
        benefit_option =
          VALUES(benefit_option),
        network_type =
          VALUES(network_type),
        line_type =
          VALUES(line_type),
        tariff_discipline =
          VALUES(tariff_discipline),
        diagnosis_code =
          VALUES(diagnosis_code),
        rendering_practitioner_id =
          VALUES(rendering_practitioner_id),
        rendering_practitioner_category =
          VALUES(
            rendering_practitioner_category
          ),
        rendering_known_to_billing_provider =
          VALUES(
            rendering_known_to_billing_provider
          ),
        tenant_id =
          VALUES(tenant_id)
    `,
    [
      claim.claim_id,
      claim.scheme_id,
      claim.member_id,
      claim.provider_id,
      claim.service_date,
      claim.received_date,
      claim.billing_code,
      claim.amount,
      claim.quantity,
      claim.benefit_option,
      claim.network_type,
      claim.line_type,
      claim.tariff_discipline,
      claim.diagnosis_code,
      claim.rendering_practitioner_id,
      claim
        .rendering_practitioner_category,
      claim
        .rendering_known_to_billing_provider,
      claim.tenant_id,
    ],
  );

  const payload = {
    claim_id:
      claim.claim_id,

    scheme_id:
      claim.scheme_id,

    member_id:
      claim.member_id,

    provider_id:
      claim.provider_id,

    service_date:
      claim.service_date,

    received_date:
      claim.received_date,

    billing_code:
      claim.billing_code,

    amount:
      claim.amount,

    quantity:
      claim.quantity,

    benefit_option:
      claim.benefit_option,

    network_type:
      claim.network_type,

    line_type:
      claim.line_type,

    tariff_discipline:
      claim.tariff_discipline,

    diagnosis_code:
      claim.diagnosis_code,

    rendering_practitioner_id:
      claim
        .rendering_practitioner_id,

    rendering_practitioner_category:
      claim
        .rendering_practitioner_category,

    rendering_known_to_billing_provider:
      claim
        .rendering_known_to_billing_provider,
  };

  await pool.execute(
    `
      INSERT IGNORE INTO claim_versions (
        tenant_id,
        claim_id,
        claim_version,
        scheme_id,
        member_id,
        provider_id,
        service_date,
        received_date,
        billing_code,
        amount,
        claim_payload,
        payload_hash,
        version_reason
      )
      VALUES (
        ?,
        ?,
        1,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        NULL,
        'legacy_baseline'
      )
    `,
    [
      claim.tenant_id,
      claim.claim_id,
      claim.scheme_id,
      claim.member_id,
      claim.provider_id,
      claim.service_date,
      claim.received_date,
      claim.billing_code,
      claim.amount,
      JSON.stringify(
        payload,
      ),
    ],
  );
}
