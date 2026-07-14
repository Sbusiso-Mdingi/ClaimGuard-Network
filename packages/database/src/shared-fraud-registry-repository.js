import crypto from "node:crypto";

export const FRAUD_SUBJECT_TYPE = Object.freeze({
  MEMBER: "MEMBER",
  PROVIDER: "PROVIDER",
  PRACTITIONER: "PRACTITIONER",
});

export const FRAUD_REGISTRY_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  REVERSED: "REVERSED",
});

const CONFIRMED_FRAUD_ENTRY_TYPE = "INVESTIGATOR_CONFIRMED_FRAUD";
const REVERSED_FRAUD_ENTRY_TYPE = "INVESTIGATOR_REVERSED_FRAUD";

const registrySelectFields = `
  registry_entry_id, ledger_hash, investigation_id, tenant_id, medical_scheme,
  fraud_subject_type, subject_token, offence_category, finding_date,
  investigator_reference, publication_timestamp, status, reverses_registry_entry_id
`;

export class FraudRegistryValidationError extends Error {
  constructor(message, code = "fraud_registry_validation_failed") {
    super(message);
    this.name = "FraudRegistryValidationError";
    this.code = code;
  }
}

export class FraudRegistryNotFoundError extends Error {
  constructor(message = "The shared fraud registry record was not found.") {
    super(message);
    this.name = "FraudRegistryNotFoundError";
    this.code = "fraud_registry_not_found";
  }
}

export class FraudRegistryConflictError extends Error {
  constructor(message, code = "fraud_registry_conflict") {
    super(message);
    this.name = "FraudRegistryConflictError";
    this.code = code;
  }
}

function requirePool(pool) {
  if (!pool || typeof pool.execute !== "function") {
    throw new Error("A mysql2 pool with execute support is required for the shared fraud registry repository.");
  }
}

function normalizeRequiredString(value, fieldName, maxLength = null) {
  if (typeof value !== "string" || !value.trim()) {
    throw new FraudRegistryValidationError(`${fieldName} is required.`);
  }

  const normalized = value.trim();
  if (maxLength && normalized.length > maxLength) {
    throw new FraudRegistryValidationError(`${fieldName} must be at most ${maxLength} characters.`);
  }

  return normalized;
}

function normalizeSubjectType(value) {
  const normalized = normalizeRequiredString(value, "fraudSubjectType", 32)
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (!Object.values(FRAUD_SUBJECT_TYPE).includes(normalized)) {
    throw new FraudRegistryValidationError(`Unsupported fraudSubjectType: ${value}.`, "invalid_fraud_subject_type");
  }

  return normalized;
}

function normalizeFindingDate(value) {
  const normalized = normalizeRequiredString(value, "findingDate", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00.000Z`))) {
    throw new FraudRegistryValidationError("findingDate must use YYYY-MM-DD format.", "invalid_finding_date");
  }

  return normalized;
}

function mapRegistryRecord(row) {
  if (!row) {
    return null;
  }

  return {
    registryEntryId: row.registry_entry_id,
    ledgerHash: row.ledger_hash,
    investigationId: row.investigation_id,
    tenantId: row.tenant_id,
    medicalScheme: row.medical_scheme,
    fraudSubjectType: row.fraud_subject_type,
    subjectToken: row.subject_token,
    offenceCategory: row.offence_category,
    findingDate: row.finding_date,
    investigatorReference: row.investigator_reference,
    publicationTimestamp: row.publication_timestamp,
    status: row.status,
    reversesRegistryEntryId: row.reverses_registry_entry_id,
  };
}

function currentRegistryRecords(records) {
  const reversedRegistryEntryIds = new Set(
    records
      .filter((record) => record.status === FRAUD_REGISTRY_STATUS.REVERSED && record.reversesRegistryEntryId)
      .map((record) => record.reversesRegistryEntryId),
  );

  return records.filter(
    (record) =>
      record.status !== FRAUD_REGISTRY_STATUS.ACTIVE || !reversedRegistryEntryIds.has(record.registryEntryId),
  );
}

export function normalizeRegistryPublicationMetadata(metadata, options = {}) {
  const source = metadata && typeof metadata === "object" ? metadata : {};
  const findingDate = source.findingDate || new Date().toISOString().slice(0, 10);

  return {
    medicalScheme: normalizeRequiredString(source.medicalScheme || options.defaultMedicalScheme, "medicalScheme", 255),
    fraudSubjectType: normalizeSubjectType(source.fraudSubjectType),
    subjectToken: normalizeRequiredString(source.subjectToken, "subjectToken", 255),
    offenceCategory: normalizeRequiredString(source.offenceCategory, "offenceCategory", 128),
    findingDate: normalizeFindingDate(findingDate),
    investigatorReference: normalizeRequiredString(
      source.investigatorReference || options.defaultInvestigatorReference,
      "investigatorReference",
      255,
    ),
  };
}

export function createSharedFraudRegistryRepository(pool) {
  requirePool(pool);

  async function getRegistryRecordById(registryEntryId) {
    const normalizedRegistryEntryId = normalizeRequiredString(registryEntryId, "registryEntryId", 64);
    const [rows] = await pool.execute(
      `
        SELECT ${registrySelectFields}
        FROM shared_fraud_registry_entries
        WHERE registry_entry_id = ?
        LIMIT 1
      `,
      [normalizedRegistryEntryId],
    );

    return mapRegistryRecord(rows?.[0] ?? null);
  }

  return {
    async publishConfirmedFraud({ ledgerEntry, investigation, metadata }) {
      if (ledgerEntry?.entryType !== CONFIRMED_FRAUD_ENTRY_TYPE) {
        throw new FraudRegistryValidationError(
          "A confirmed-fraud ledger entry is required to publish a registry record.",
          "invalid_registry_ledger_event",
        );
      }

      const ledgerHash = normalizeRequiredString(ledgerEntry.entryHash, "ledgerHash", 64);
      const investigationId = normalizeRequiredString(investigation?.investigationId, "investigationId", 64);
      const tenantId = normalizeRequiredString(investigation?.tenantId, "tenantId", 64);
      const normalizedMetadata = normalizeRegistryPublicationMetadata(metadata);
      const registryEntryId = crypto.randomUUID();
      const publicationTimestamp = new Date().toISOString();

      try {
        await pool.execute(
          `
            INSERT INTO shared_fraud_registry_entries (
              registry_entry_id, ledger_hash, investigation_id, tenant_id, medical_scheme,
              fraud_subject_type, subject_token, offence_category, finding_date,
              investigator_reference, status, reverses_registry_entry_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            registryEntryId,
            ledgerHash,
            investigationId,
            tenantId,
            normalizedMetadata.medicalScheme,
            normalizedMetadata.fraudSubjectType,
            normalizedMetadata.subjectToken,
            normalizedMetadata.offenceCategory,
            normalizedMetadata.findingDate,
            normalizedMetadata.investigatorReference,
            FRAUD_REGISTRY_STATUS.ACTIVE,
            null,
          ],
        );
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") {
          throw new FraudRegistryConflictError(
            "This ledger event has already been published to the shared fraud registry.",
            "registry_ledger_event_already_published",
          );
        }
        throw error;
      }

      return {
        registryEntryId,
        ledgerHash,
        investigationId,
        tenantId,
        ...normalizedMetadata,
        publicationTimestamp,
        status: FRAUD_REGISTRY_STATUS.ACTIVE,
        reversesRegistryEntryId: null,
      };
    },

    async publishFraudReversal({ ledgerEntry, investigation, originalRegistryEntry, investigatorReference }) {
      if (ledgerEntry?.entryType !== REVERSED_FRAUD_ENTRY_TYPE) {
        throw new FraudRegistryValidationError(
          "A fraud-reversal ledger entry is required to publish a reversal registry record.",
          "invalid_registry_ledger_event",
        );
      }

      const ledgerHash = normalizeRequiredString(ledgerEntry.entryHash, "ledgerHash", 64);
      const investigationId = normalizeRequiredString(investigation?.investigationId, "investigationId", 64);
      const tenantId = normalizeRequiredString(investigation?.tenantId, "tenantId", 64);
      const original = originalRegistryEntry || null;

      if (
        !original ||
        original.status !== FRAUD_REGISTRY_STATUS.ACTIVE ||
        original.investigationId !== investigationId ||
        original.tenantId !== tenantId
      ) {
        throw new FraudRegistryConflictError(
          "An active registry finding for this investigation is required before it can be reversed.",
          "active_registry_finding_not_found",
        );
      }

      const normalizedInvestigatorReference = normalizeRequiredString(
        investigatorReference,
        "investigatorReference",
        255,
      );
      const registryEntryId = crypto.randomUUID();
      const publicationTimestamp = new Date().toISOString();

      try {
        await pool.execute(
          `
            INSERT INTO shared_fraud_registry_entries (
              registry_entry_id, ledger_hash, investigation_id, tenant_id, medical_scheme,
              fraud_subject_type, subject_token, offence_category, finding_date,
              investigator_reference, status, reverses_registry_entry_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            registryEntryId,
            ledgerHash,
            investigationId,
            tenantId,
            original.medicalScheme,
            original.fraudSubjectType,
            original.subjectToken,
            original.offenceCategory,
            original.findingDate,
            normalizedInvestigatorReference,
            FRAUD_REGISTRY_STATUS.REVERSED,
            original.registryEntryId,
          ],
        );
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") {
          throw new FraudRegistryConflictError(
            "This ledger event has already been published to the shared fraud registry.",
            "registry_ledger_event_already_published",
          );
        }
        throw error;
      }

      return {
        registryEntryId,
        ledgerHash,
        investigationId,
        tenantId,
        medicalScheme: original.medicalScheme,
        fraudSubjectType: original.fraudSubjectType,
        subjectToken: original.subjectToken,
        offenceCategory: original.offenceCategory,
        findingDate: original.findingDate,
        investigatorReference: normalizedInvestigatorReference,
        publicationTimestamp,
        status: FRAUD_REGISTRY_STATUS.REVERSED,
        reversesRegistryEntryId: original.registryEntryId,
      };
    },

    async getRegistryRecordById(registryEntryId) {
      return getRegistryRecordById(registryEntryId);
    },

    async searchRegistry({ subjectToken, fraudSubjectType = null }) {
      const normalizedSubjectToken = normalizeRequiredString(subjectToken, "subjectToken", 255);
      const normalizedSubjectType = fraudSubjectType ? normalizeSubjectType(fraudSubjectType) : null;
      const [rows] = await pool.execute(
        `
          SELECT ${registrySelectFields}
          FROM shared_fraud_registry_entries
          WHERE subject_token = ?
            AND (? IS NULL OR fraud_subject_type = ?)
          ORDER BY publication_timestamp ASC, registry_entry_id ASC
        `,
        [normalizedSubjectToken, normalizedSubjectType, normalizedSubjectType],
      );

      return currentRegistryRecords((rows || []).map(mapRegistryRecord));
    },

    async getRegistryHistory(subjectToken) {
      const normalizedSubjectToken = normalizeRequiredString(subjectToken, "subjectToken", 255);
      const [rows] = await pool.execute(
        `
          SELECT ${registrySelectFields}
          FROM shared_fraud_registry_entries
          WHERE subject_token = ?
          ORDER BY publication_timestamp ASC, registry_entry_id ASC
        `,
        [normalizedSubjectToken],
      );

      return (rows || []).map(mapRegistryRecord);
    },

    async getActiveRegistryFindingForInvestigation({ investigationId, tenantId }) {
      const normalizedInvestigationId = normalizeRequiredString(investigationId, "investigationId", 64);
      const normalizedTenantId = normalizeRequiredString(tenantId, "tenantId", 64);
      const [rows] = await pool.execute(
        `
          SELECT ${registrySelectFields}
          FROM shared_fraud_registry_entries active_entry
          WHERE active_entry.investigation_id = ?
            AND active_entry.tenant_id = ?
            AND active_entry.status = 'ACTIVE'
            AND NOT EXISTS (
              SELECT 1
              FROM shared_fraud_registry_entries reversal_entry
              WHERE reversal_entry.reverses_registry_entry_id = active_entry.registry_entry_id
            )
          ORDER BY active_entry.publication_timestamp DESC, active_entry.registry_entry_id DESC
          LIMIT 1
        `,
        [normalizedInvestigationId, normalizedTenantId],
      );

      return mapRegistryRecord(rows?.[0] ?? null);
    },
  };
}
