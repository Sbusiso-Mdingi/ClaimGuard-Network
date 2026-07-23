import crypto from "node:crypto";

import {
  enqueueClaimProcessingJob,
} from "./claim-processing-outbox-repository.js";
import {
  repositoryTenantId,
} from "./repository-context.js";

const MAX_CLAIM_VERSION = 2_147_483_647;

const SUPPORTED_STRATEGIES = new Set([
  "deterministic_rules",
  "approved_model",
]);

const DEPLOYMENT_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ClaimOwnershipConflictError
  extends Error {
  constructor(
    message = (
      "Claim identifier is already owned "
      + "by another tenant."
    ),
  ) {
    super(message);

    this.name =
      "ClaimOwnershipConflictError";

    this.code =
      "CLAIM_OWNERSHIP_CONFLICT";

    this.status = 409;
  }
}

export class ReferenceOwnershipConflictError
  extends Error {
  constructor(entityType, entityId) {
    super(
      `${entityType} identifier ${entityId} `
      + "is already owned by another tenant.",
    );

    this.name =
      "ReferenceOwnershipConflictError";

    this.code =
      "REFERENCE_OWNERSHIP_CONFLICT";

    this.status = 409;
  }
}

export class ClaimReferenceValidationError
  extends Error {
  constructor(entityType, entityId) {
    super(
      `${entityType} identifier ${entityId} `
      + "is not valid for the authenticated "
      + "tenant and scheme.",
    );

    this.name =
      "ClaimReferenceValidationError";

    this.code =
      "CLAIM_REFERENCE_INVALID";

    this.status = 422;
  }
}

export class ClaimIngestionValidationError
  extends Error {
  constructor(message) {
    super(message);

    this.name =
      "ClaimIngestionValidationError";

    this.code =
      "CLAIM_INGESTION_INVALID";

    this.status = 400;
  }
}

export class ClaimVersionIntegrityError
  extends Error {
  constructor(message) {
    super(message);

    this.name =
      "ClaimVersionIntegrityError";

    this.code =
      "CLAIM_VERSION_INTEGRITY_ERROR";

    this.status = 500;
  }
}

function invalid(message) {
  return new ClaimIngestionValidationError(
    message,
  );
}

function requireText(
  value,
  field,
  maxLength = null,
) {
  const normalized =
    typeof value === "string"
      ? value.trim()
      : "";

  if (!normalized) {
    throw invalid(
      `${field} is required.`,
    );
  }

  if (
    maxLength !== null
    && normalized.length > maxLength
  ) {
    throw invalid(
      `${field} must not exceed `
      + `${maxLength} characters.`,
    );
  }

  return normalized;
}

function optionalText(
  value,
  field,
  maxLength = null,
) {
  if (
    value === null
    || value === undefined
    || value === ""
  ) {
    return null;
  }

  return requireText(
    value,
    field,
    maxLength,
  );
}

function canonicalDate(
  value,
  field,
) {
  const rendered =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value ?? "").trim();

  const match =
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(
      rendered,
    );

  if (!match) {
    throw invalid(
      `${field} must be an ISO calendar date.`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const parsed = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
    ),
  );

  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw invalid(
      `${field} must be a valid `
      + "ISO calendar date.",
    );
  }

  return rendered;
}

function canonicalDecimal(
  value,
  field,
  scale,
  maximum,
) {
  if (
    value === null
    || value === undefined
    || value === ""
    || typeof value === "boolean"
  ) {
    throw invalid(
      `${field} must be a positive number.`,
    );
  }

  const parsed = Number(value);

  if (
    !Number.isFinite(parsed)
    || parsed <= 0
    || parsed > maximum
  ) {
    throw invalid(
      `${field} must be greater than zero `
      + `and not exceed ${maximum}.`,
    );
  }

  const multiplier =
    10 ** scale;

  const scaled = Math.round(
    parsed * multiplier,
  );

  if (
    !Number.isSafeInteger(scaled)
    || Math.abs(
      parsed * multiplier - scaled,
    ) > 1e-7
  ) {
    throw invalid(
      `${field} must contain no more than `
      + `${scale} decimal places.`,
    );
  }

  return (
    scaled / multiplier
  ).toFixed(scale);
}

function canonicalBoolean(
  value,
  field,
) {
  if (typeof value === "boolean") {
    return value;
  }

  if (
    value === 1
    || value === "1"
    || value === "true"
  ) {
    return true;
  }

  if (
    value === 0
    || value === "0"
    || value === "false"
  ) {
    return false;
  }

  throw invalid(
    `${field} must be a boolean.`,
  );
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (
    value
    && typeof value === "object"
    && !(value instanceof Date)
    && !Buffer.isBuffer(value)
  ) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          sortValue(value[key]),
        ]),
    );
  }

  return value;
}

function stableStringify(value) {
  return JSON.stringify(
    sortValue(value),
  );
}

function hashClaim(claim) {
  return crypto
    .createHash("sha256")
    .update(
      stableStringify(claim),
      "utf8",
    )
    .digest("hex");
}

function normalizeClaim(
  rawClaim,
  index,
) {
  if (
    !rawClaim
    || typeof rawClaim !== "object"
    || Array.isArray(rawClaim)
  ) {
    throw invalid(
      `claims[${index}] must be an object.`,
    );
  }

  const claim = {
    claim_id: requireText(
      rawClaim.claim_id,
      `claims[${index}].claim_id`,
      32,
    ),

    scheme_id: requireText(
      rawClaim.scheme_id,
      `claims[${index}].scheme_id`,
      8,
    ),

    member_id: requireText(
      rawClaim.member_id,
      `claims[${index}].member_id`,
      32,
    ),

    provider_id: requireText(
      rawClaim.provider_id,
      `claims[${index}].provider_id`,
      32,
    ),

    service_date: canonicalDate(
      rawClaim.service_date,
      `claims[${index}].service_date`,
    ),

    received_date: canonicalDate(
      rawClaim.received_date,
      `claims[${index}].received_date`,
    ),

    billing_code: requireText(
      rawClaim.billing_code,
      `claims[${index}].billing_code`,
      32,
    ),

    amount: canonicalDecimal(
      rawClaim.amount,
      `claims[${index}].amount`,
      2,
      9_999_999_999.99,
    ),

    quantity: canonicalDecimal(
      rawClaim.quantity,
      `claims[${index}].quantity`,
      3,
      999_999_999.999,
    ),

    benefit_option: requireText(
      rawClaim.benefit_option,
      `claims[${index}].benefit_option`,
      128,
    ),

    network_type: requireText(
      rawClaim.network_type,
      `claims[${index}].network_type`,
      64,
    ),

    line_type: requireText(
      rawClaim.line_type,
      `claims[${index}].line_type`,
      64,
    ),

    tariff_discipline: requireText(
      rawClaim.tariff_discipline,
      `claims[${index}].tariff_discipline`,
      128,
    ),

    diagnosis_code: requireText(
      rawClaim.diagnosis_code,
      `claims[${index}].diagnosis_code`,
      32,
    ),

    rendering_practitioner_id:
      optionalText(
        rawClaim.rendering_practitioner_id,
        `claims[${index}]`
        + ".rendering_practitioner_id",
        128,
      ),

    rendering_practitioner_category:
      requireText(
        rawClaim
          .rendering_practitioner_category,
        `claims[${index}]`
        + ".rendering_practitioner_category",
        128,
      ),

    rendering_known_to_billing_provider:
      canonicalBoolean(
        rawClaim
          .rendering_known_to_billing_provider,
        `claims[${index}]`
        + ".rendering_known_to_billing_provider",
      ),
  };

  if (
    claim.received_date
    < claim.service_date
  ) {
    throw invalid(
      `Claim ${claim.claim_id} received_date `
      + "cannot be earlier than service_date.",
    );
  }

  if (
    claim.rendering_practitioner_id === null
    && (
      claim
        .rendering_practitioner_category
        !== "NONE"
      || claim
        .rendering_known_to_billing_provider
    )
  ) {
    throw invalid(
      `Claim ${claim.claim_id} has `
      + "inconsistent rendering-practitioner data.",
    );
  }

  if (
    claim.rendering_practitioner_id !== null
    && claim
      .rendering_practitioner_category
      === "NONE"
  ) {
    throw invalid(
      `Claim ${claim.claim_id} has `
      + "inconsistent rendering-practitioner data.",
    );
  }

  return claim;
}

function normalizeClaims(claims) {
  if (
    !Array.isArray(claims)
    || claims.length === 0
  ) {
    throw invalid(
      "claims must be a non-empty array.",
    );
  }

  const normalized =
    claims.map(normalizeClaim);

  const seen = new Set();

  for (const claim of normalized) {
    if (seen.has(claim.claim_id)) {
      throw invalid(
        "claims contains duplicate claim "
        + `identifier ${claim.claim_id}.`,
      );
    }

    seen.add(claim.claim_id);
  }

  return normalized;
}

function configuredMaxAttempts(value) {
  const parsed = Number(value);

  return (
    Number.isSafeInteger(parsed)
    && parsed > 0
  )
    ? Math.min(parsed, 100)
    : 5;
}

function emptyWriteSummary(
  received = 0,
) {
  return {
    received,
    inserted: 0,
    updated: 0,
  };
}

async function readOwner(
  connection,
  tableName,
  idColumn,
  entityId,
) {
  const [rows] =
    await connection.execute(
      `SELECT tenant_id
       FROM ${tableName}
       WHERE ${idColumn} = ?
       FOR UPDATE`,
      [entityId],
    );

  return rows?.[0]?.tenant_id ?? null;
}

function referenceCacheKey(
  tableName,
  entityId,
  schemeId = null,
) {
  return (
    `${tableName}:`
    + `${entityId}:`
    + `${schemeId || ""}`
  );
}

async function assertTenantReference(
  connection,
  {
    tableName,
    idColumn,
    entityType,
    entityId,
    tenantId,
    schemeId = null,
    cache,
  },
) {
  const cacheKey =
    referenceCacheKey(
      tableName,
      entityId,
      schemeId,
    );

  if (cache.has(cacheKey)) {
    return;
  }

  const selectedColumns =
    schemeId === null
      ? "tenant_id"
      : "tenant_id, scheme_id";

  const [rows] =
    await connection.execute(
      `SELECT ${selectedColumns}
       FROM ${tableName}
       WHERE ${idColumn} = ?
       FOR UPDATE`,
      [entityId],
    );

  const record =
    rows?.[0] || null;

  if (
    !record
    || record.tenant_id !== tenantId
    || (
      schemeId !== null
      && record.scheme_id !== schemeId
    )
  ) {
    throw new ClaimReferenceValidationError(
      entityType,
      entityId,
    );
  }

  cache.add(cacheKey);
}

async function upsertTenantOwnedRecord(
  connection,
  {
    tableName,
    idColumn,
    entityType,
    entityId,
    tenantId,
    insertSql,
    insertParams,
    updateSql,
    updateParams,
  },
) {
  const existingOwner =
    await readOwner(
      connection,
      tableName,
      idColumn,
      entityId,
    );

  if (
    existingOwner
    && existingOwner !== tenantId
  ) {
    throw new ReferenceOwnershipConflictError(
      entityType,
      entityId,
    );
  }

  if (existingOwner) {
    await connection.execute(
      updateSql,
      [
        ...updateParams,
        entityId,
        tenantId,
      ],
    );

    return "updated";
  }

  try {
    await connection.execute(
      insertSql,
      [
        ...insertParams,
        tenantId,
      ],
    );

    return "inserted";
  } catch (error) {
    if (error?.code !== "ER_DUP_ENTRY") {
      throw error;
    }

    const racedOwner =
      await readOwner(
        connection,
        tableName,
        idColumn,
        entityId,
      );

    if (racedOwner !== tenantId) {
      throw new ReferenceOwnershipConflictError(
        entityType,
        entityId,
      );
    }

    await connection.execute(
      updateSql,
      [
        ...updateParams,
        entityId,
        tenantId,
      ],
    );

    return "updated";
  }
}

function recordWrite(
  summary,
  result,
) {
  summary[result] += 1;
}

async function ingestReferenceData(
  connection,
  {
    schemes,
    members,
    providers,
    tenantId,
    referenceCache,
  },
) {
  const summary = {
    schemes:
      emptyWriteSummary(schemes.length),

    members:
      emptyWriteSummary(members.length),

    providers:
      emptyWriteSummary(providers.length),
  };

  for (const scheme of schemes) {
    const result =
      await upsertTenantOwnedRecord(
        connection,
        {
          tableName: "schemes",
          idColumn: "scheme_id",
          entityType: "Scheme",
          entityId: scheme.scheme_id,
          tenantId,

          insertSql: `
            INSERT INTO schemes (
              scheme_id,
              scheme_name,
              tenant_id
            )
            VALUES (?, ?, ?)
          `,

          insertParams: [
            scheme.scheme_id,
            scheme.scheme_name,
          ],

          updateSql: `
            UPDATE schemes
            SET scheme_name = ?
            WHERE scheme_id = ?
              AND tenant_id = ?
          `,

          updateParams: [
            scheme.scheme_name,
          ],
        },
      );

    recordWrite(
      summary.schemes,
      result,
    );

    referenceCache.add(
      referenceCacheKey(
        "schemes",
        scheme.scheme_id,
      ),
    );

    await connection.execute(
      `
        INSERT INTO medical_schemes (
          tenant_id,
          scheme_id,
          scheme_name,
          is_primary
        )
        VALUES (?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          scheme_name = VALUES(scheme_name)
      `,
      [
        tenantId,
        scheme.scheme_id,
        scheme.scheme_name,
      ],
    );
  }

  for (const member of members) {
    await assertTenantReference(
      connection,
      {
        tableName: "schemes",
        idColumn: "scheme_id",
        entityType: "Scheme",
        entityId: member.scheme_id,
        tenantId,
        cache: referenceCache,
      },
    );

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

    const result =
      await upsertTenantOwnedRecord(
        connection,
        {
          tableName: "members",
          idColumn: "member_id",
          entityType: "Member",
          entityId: member.member_id,
          tenantId,

          insertSql: `
            INSERT INTO members (
              member_id,
              scheme_id,
              first_name,
              last_name,
              date_of_birth,
              gender,
              identity_number,
              banking_detail,
              home_region,
              home_lat,
              home_lon,
              join_date,
              tenant_id
            )
            VALUES (
              ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?
            )
          `,

          insertParams: [
            member.member_id,
            ...values,
          ],

          updateSql: `
            UPDATE members
            SET
              scheme_id = ?,
              first_name = ?,
              last_name = ?,
              date_of_birth = ?,
              gender = ?,
              identity_number = ?,
              banking_detail = ?,
              home_region = ?,
              home_lat = ?,
              home_lon = ?,
              join_date = ?
            WHERE member_id = ?
              AND tenant_id = ?
          `,

          updateParams: values,
        },
      );

    recordWrite(
      summary.members,
      result,
    );

    referenceCache.add(
      referenceCacheKey(
        "members",
        member.member_id,
        member.scheme_id,
      ),
    );
  }

  for (const provider of providers) {
    await assertTenantReference(
      connection,
      {
        tableName: "schemes",
        idColumn: "scheme_id",
        entityType: "Scheme",
        entityId: provider.scheme_id,
        tenantId,
        cache: referenceCache,
      },
    );

    const values = [
      provider.scheme_id,
      provider.practice_number,
      provider.specialty,
      provider.practice_name,
      provider.banking_detail,
      provider.practice_region,
      provider.practice_lat,
      provider.practice_lon,
      provider.provider_kind,
      provider.provider_category,
    ];

    const result =
      await upsertTenantOwnedRecord(
        connection,
        {
          tableName: "providers",
          idColumn: "provider_id",
          entityType: "Provider",
          entityId: provider.provider_id,
          tenantId,

          insertSql: `
            INSERT INTO providers (
              provider_id,
              scheme_id,
              practice_number,
              specialty,
              practice_name,
              banking_detail,
              practice_region,
              practice_lat,
              practice_lon,
              provider_kind,
              provider_category,
              tenant_id
            )
            VALUES (
              ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?
            )
          `,

          insertParams: [
            provider.provider_id,
            ...values,
          ],

          updateSql: `
            UPDATE providers
            SET
              scheme_id = ?,
              practice_number = ?,
              specialty = ?,
              practice_name = ?,
              banking_detail = ?,
              practice_region = ?,
              practice_lat = ?,
              practice_lon = ?,
              provider_kind = ?,
              provider_category = ?
            WHERE provider_id = ?
              AND tenant_id = ?
          `,

          updateParams: values,
        },
      );

    recordWrite(
      summary.providers,
      result,
    );

    referenceCache.add(
      referenceCacheKey(
        "providers",
        provider.provider_id,
        provider.scheme_id,
      ),
    );
  }

  return summary;
}

async function readActiveStrategy(
  connection,
  tenantId,
) {
  const [rows] =
    await connection.execute(
      `
        SELECT
          id,
          strategy_type,
          model_deployment_id
        FROM detection_strategies
        WHERE tenant_id = ?
          AND is_active = 1
        ORDER BY
          activated_at DESC,
          id DESC
        LIMIT 2
        FOR UPDATE
      `,
      [tenantId],
    );

  if (
    (rows || []).length !== 1
  ) {
    throw new ClaimVersionIntegrityError(
      rows?.length
        ? (
          "Tenant has multiple active "
          + "detection strategies."
        )
        : (
          "Tenant has no active "
          + "detection strategy."
        ),
    );
  }

  const row = rows[0];
  const id = Number(row.id);

  const strategyType =
    String(
      row.strategy_type || "",
    ).trim();

  const modelDeploymentId =
    String(
      row.model_deployment_id || "",
    ).trim() || null;

  if (
    !Number.isSafeInteger(id)
    || id <= 0
    || !SUPPORTED_STRATEGIES.has(
      strategyType,
    )
  ) {
    throw new ClaimVersionIntegrityError(
      "The active detection strategy is invalid.",
    );
  }

  if (
    strategyType === "approved_model"
    && (
      !modelDeploymentId
      || !DEPLOYMENT_ID_PATTERN.test(
        modelDeploymentId,
      )
    )
  ) {
    throw new ClaimVersionIntegrityError(
      "The approved model strategy "
      + "has no valid deployment identifier.",
    );
  }

  if (
    strategyType === "deterministic_rules"
    && modelDeploymentId !== null
  ) {
    throw new ClaimVersionIntegrityError(
      "The deterministic strategy unexpectedly "
      + "references a model deployment.",
    );
  }

  return {
    id,
    strategyType,
    modelDeploymentId,
  };
}

function claimValues(claim) {
  return [
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
  ];
}

async function assertClaimReferences(
  connection,
  {
    claim,
    tenantId,
    referenceCache,
  },
) {
  await assertTenantReference(
    connection,
    {
      tableName: "schemes",
      idColumn: "scheme_id",
      entityType: "Scheme",
      entityId: claim.scheme_id,
      tenantId,
      cache: referenceCache,
    },
  );

  await assertTenantReference(
    connection,
    {
      tableName: "members",
      idColumn: "member_id",
      entityType: "Member",
      entityId: claim.member_id,
      tenantId,
      schemeId: claim.scheme_id,
      cache: referenceCache,
    },
  );

  await assertTenantReference(
    connection,
    {
      tableName: "providers",
      idColumn: "provider_id",
      entityType: "Provider",
      entityId: claim.provider_id,
      tenantId,
      schemeId: claim.scheme_id,
      cache: referenceCache,
    },
  );
}

function parseClaimPayload(
  value,
  claimId,
) {
  let parsed = value;

  if (Buffer.isBuffer(parsed)) {
    parsed = parsed.toString("utf8");
  }

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new ClaimVersionIntegrityError(
        `Claim ${claimId} has invalid `
        + "version payload JSON.",
      );
    }
  }

  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
  ) {
    throw new ClaimVersionIntegrityError(
      `Claim ${claimId} has an invalid `
      + "version payload.",
    );
  }

  return parsed;
}

async function readCurrentClaim(
  connection,
  claimId,
) {
  const [rows] =
    await connection.execute(
      `
        SELECT
          c.tenant_id,
          c.current_claim_version,
          cv.payload_hash,
          cv.claim_payload
        FROM claims c
        LEFT JOIN claim_versions cv
          ON cv.tenant_id = c.tenant_id
         AND cv.claim_id = c.claim_id
         AND cv.claim_version =
           c.current_claim_version
        WHERE c.claim_id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [claimId],
    );

  const row =
    rows?.[0] || null;

  if (!row) {
    return null;
  }

  const currentClaimVersion =
    Number(
      row.current_claim_version,
    );

  if (
    !Number.isSafeInteger(
      currentClaimVersion,
    )
    || currentClaimVersion <= 0
    || currentClaimVersion
      > MAX_CLAIM_VERSION
  ) {
    throw new ClaimVersionIntegrityError(
      `Claim ${claimId} has an invalid `
      + "current-version pointer.",
    );
  }

  let currentPayloadHash =
    String(
      row.payload_hash || "",
    );

  if (
    !/^[a-f0-9]{64}$/.test(
      currentPayloadHash,
    )
  ) {
    const storedClaim =
      normalizeClaim(
        parseClaimPayload(
          row.claim_payload,
          claimId,
        ),
        0,
      );

    if (
      storedClaim.claim_id !== claimId
    ) {
      throw new ClaimVersionIntegrityError(
        `Claim ${claimId} has a mismatched `
        + "version payload.",
      );
    }

    currentPayloadHash =
      hashClaim(storedClaim);

    await connection.execute(
      `
        UPDATE claim_versions
        SET payload_hash = ?
        WHERE tenant_id = ?
          AND claim_id = ?
          AND claim_version = ?
          AND (
            payload_hash IS NULL
            OR payload_hash = ''
          )
      `,
      [
        currentPayloadHash,
        row.tenant_id,
        claimId,
        currentClaimVersion,
      ],
    );
  }

  return {
    tenantId: row.tenant_id,
    currentClaimVersion,
    currentPayloadHash,
  };
}

async function insertClaimVersion(
  connection,
  {
    tenantId,
    claim,
    claimVersion,
    claimPayload,
    claimPayloadHash,
    versionReason,
  },
) {
  await connection.execute(
    `
      INSERT INTO claim_versions (
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
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `,
    [
      tenantId,
      claim.claim_id,
      claimVersion,
      claim.scheme_id,
      claim.member_id,
      claim.provider_id,
      claim.service_date,
      claim.received_date,
      claim.billing_code,
      claim.amount,
      claimPayload,
      claimPayloadHash,
      versionReason,
    ],
  );
}

async function insertNewClaim(
  connection,
  {
    tenantId,
    claim,
    claimPayload,
    claimPayloadHash,
  },
) {
  await connection.execute(
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
        ?, 1, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `,
    [
      claim.claim_id,
      ...claimValues(claim),
      tenantId,
    ],
  );

  await insertClaimVersion(
    connection,
    {
      tenantId,
      claim,
      claimVersion: 1,
      claimPayload,
      claimPayloadHash,
      versionReason:
        "initial_submission",
    },
  );

  return {
    disposition: "inserted",

    target: {
      claim_id: claim.claim_id,
      claim_version: 1,
    },
  };
}

async function updateExistingClaim(
  connection,
  {
    tenantId,
    claim,
    current,
    claimPayload,
    claimPayloadHash,
  },
) {
  if (
    current.tenantId !== tenantId
  ) {
    throw new ClaimOwnershipConflictError();
  }

  if (
    current.currentPayloadHash
    === claimPayloadHash
  ) {
    return {
      disposition: "unchanged",
      target: null,
    };
  }

  if (
    current.currentClaimVersion
    >= MAX_CLAIM_VERSION
  ) {
    throw new ClaimVersionIntegrityError(
      `Claim ${claim.claim_id} exceeded `
      + "the supported version range.",
    );
  }

  const nextVersion =
    current.currentClaimVersion + 1;

  await insertClaimVersion(
    connection,
    {
      tenantId,
      claim,
      claimVersion: nextVersion,
      claimPayload,
      claimPayloadHash,
      versionReason:
        "claim_amendment",
    },
  );

  const [result] =
    await connection.execute(
      `
        UPDATE claims
        SET
          current_claim_version = ?,
          scheme_id = ?,
          member_id = ?,
          provider_id = ?,
          service_date = ?,
          received_date = ?,
          billing_code = ?,
          amount = ?,
          quantity = ?,
          benefit_option = ?,
          network_type = ?,
          line_type = ?,
          tariff_discipline = ?,
          diagnosis_code = ?,
          rendering_practitioner_id = ?,
          rendering_practitioner_category = ?,
          rendering_known_to_billing_provider = ?
        WHERE claim_id = ?
          AND tenant_id = ?
          AND current_claim_version = ?
      `,
      [
        nextVersion,
        ...claimValues(claim),
        claim.claim_id,
        tenantId,
        current.currentClaimVersion,
      ],
    );

  if (
    Number(
      result?.affectedRows || 0,
    ) !== 1
  ) {
    throw new ClaimVersionIntegrityError(
      `Claim ${claim.claim_id} changed `
      + "while its amendment was being committed.",
    );
  }

  return {
    disposition: "updated",

    target: {
      claim_id: claim.claim_id,
      claim_version: nextVersion,
    },
  };
}

async function persistClaim(
  connection,
  {
    tenantId,
    claim,
    referenceCache,
  },
) {
  await assertClaimReferences(
    connection,
    {
      claim,
      tenantId,
      referenceCache,
    },
  );

  const claimPayload =
    stableStringify(claim);

  const claimPayloadHash =
    hashClaim(claim);

  const current =
    await readCurrentClaim(
      connection,
      claim.claim_id,
    );

  if (current) {
    return updateExistingClaim(
      connection,
      {
        tenantId,
        claim,
        current,
        claimPayload,
        claimPayloadHash,
      },
    );
  }

  try {
    return await insertNewClaim(
      connection,
      {
        tenantId,
        claim,
        claimPayload,
        claimPayloadHash,
      },
    );
  } catch (error) {
    if (
      error?.code !== "ER_DUP_ENTRY"
    ) {
      throw error;
    }

    const racedCurrent =
      await readCurrentClaim(
        connection,
        claim.claim_id,
      );

    if (!racedCurrent) {
      throw new ClaimVersionIntegrityError(
        `Claim ${claim.claim_id} collided `
        + "during insertion but could not "
        + "be reloaded.",
      );
    }

    return updateExistingClaim(
      connection,
      {
        tenantId,
        claim,
        current: racedCurrent,
        claimPayload,
        claimPayloadHash,
      },
    );
  }
}

function processingResult(
  outboxJob,
  correlationId,
) {
  if (!outboxJob) {
    return {
      status: "not_queued",
      asynchronous: false,
      jobId: null,
      correlationId:
        correlationId || null,
      reused: false,
      skipped: true,
      reason: "no_claim_changes",
    };
  }

  return {
    status: [
      "pending",
      "processing",
      "retry",
    ].includes(outboxJob.status)
      ? "queued"
      : outboxJob.status,

    asynchronous: true,

    jobId: outboxJob.id,

    correlationId:
      outboxJob.correlationId,

    reused:
      !outboxJob.enqueued,

    skipped: false,

    reason: null,
  };
}

export function createClaimIngestionRepository(
  pool,
  {
    maxOutboxAttempts =
      process.env
        .REPORT_WORKER_MAX_ATTEMPTS
      || process.env
        .CLAIM_OUTBOX_MAX_ATTEMPTS,

    dataPlaneContext = null,

    allowLegacyTenantContext = false,
  } = {},
) {
  if (
    !pool
    || typeof pool.getConnection
      !== "function"
  ) {
    throw invalid(
      "A MySQL-compatible pool is required.",
    );
  }

  if (
    !dataPlaneContext
    && !allowLegacyTenantContext
  ) {
    repositoryTenantId(null);
  }

  const canonicalTenantId = () =>
    repositoryTenantId(
      dataPlaneContext,
      {
        allowLegacyTenantContext,
      },
    );

  return {
    async ingestClaims({
      claims,
      schemes = [],
      members = [],
      providers = [],
      source = "api",
      correlationId = null,
    }) {
      if (
        ![
          schemes,
          members,
          providers,
        ].every(Array.isArray)
      ) {
        throw invalid(
          "schemes, members, and providers "
          + "must be arrays.",
        );
      }

      const normalizedClaims =
        normalizeClaims(claims);

      const canonicalSource =
        requireText(
          source,
          "source",
          128,
        );

      const canonicalCorrelationId =
        (
          correlationId === null
          || correlationId === undefined
          || correlationId === ""
        )
          ? null
          : requireText(
            correlationId,
            "correlationId",
            128,
          );

      const tenantId =
        canonicalTenantId();

      const connection =
        await pool.getConnection();

      const referenceCache =
        new Set();

      const summary = {
        inserted: 0,
        updated: 0,
        unchanged: 0,
        targets: [],
      };

      let referenceData = null;
      let outboxJob = null;

      try {
        await connection.beginTransaction();

        const activeStrategy =
          await readActiveStrategy(
            connection,
            tenantId,
          );

        referenceData =
          await ingestReferenceData(
            connection,
            {
              schemes,
              members,
              providers,
              tenantId,
              referenceCache,
            },
          );

        for (
          const claim
          of normalizedClaims
        ) {
          const result =
            await persistClaim(
              connection,
              {
                tenantId,
                claim,
                referenceCache,
              },
            );

          summary[
            result.disposition
          ] += 1;

          if (result.target) {
            summary.targets.push(
              result.target,
            );
          }
        }

        if (
          summary.targets.length > 0
        ) {
          outboxJob =
            await enqueueClaimProcessingJob(
              connection,
              {
                tenantId,

                targets:
                  summary.targets,

                source:
                  canonicalSource,

                correlationId:
                  canonicalCorrelationId
                  || undefined,

                maxAttempts:
                  configuredMaxAttempts(
                    maxOutboxAttempts,
                  ),

                detectionStrategyId:
                  activeStrategy.id,

                strategyType:
                  activeStrategy
                    .strategyType,

                modelDeploymentId:
                  activeStrategy
                    .modelDeploymentId,
              },
            );
        }

        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      return {
        received:
          normalizedClaims.length,

        inserted:
          summary.inserted,

        updated:
          summary.updated,

        unchanged:
          summary.unchanged,

        versioned:
          summary.targets.length,

        source:
          canonicalSource,

        referenceData,

        processing:
          processingResult(
            outboxJob,
            canonicalCorrelationId,
          ),
      };
    },
  };
}
