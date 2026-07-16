import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createLedgerEntry, genesisPreviousHash } from "./index.js";
import { applyMigrations } from "./migrate.js";

const syntheticSchemeNames = {
  A: "Nedbank Health",
  B: "MedSecure",
  C: "HealthFirst",
};

const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const defaultSourceDir = join(moduleDir, "..", "..", "data-generator", "data");

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

async function readCsvRecords(filePath) {
  const content = await readFile(filePath, "utf8");
  const lines = content.trim().split(/\r?\n/);
  const headers = splitCsvLine(lines[0]);

  return lines.slice(1).filter(Boolean).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

async function readJsonFile(filePath) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

function toNumber(value) {
  return Number(value);
}

function normalizeSchemeRows(schemeId, rows, kind) {
  return rows.map((row) => {
    if (kind === "member") {
      return {
        ...row,
        home_lat: toNumber(row.home_lat),
        home_lon: toNumber(row.home_lon),
      };
    }

    if (kind === "provider") {
      return {
        ...row,
        practice_lat: toNumber(row.practice_lat),
        practice_lon: toNumber(row.practice_lon),
      };
    }

    if (kind === "claim") {
      return {
        ...row,
        amount: toNumber(row.amount),
      };
    }

    return row;
  }).map((row) => ({ ...row, scheme_id: schemeId }));
}

export async function loadSyntheticPhase1Data(sourceDir = defaultSourceDir) {
  const schemes = Object.keys(syntheticSchemeNames).map((schemeId) => ({
    scheme_id: schemeId,
    scheme_name: syntheticSchemeNames[schemeId],
  }));

  const members = [];
  const providers = [];
  const claims = [];

  for (const schemeId of Object.keys(syntheticSchemeNames)) {
    const schemeDir = join(sourceDir, `scheme_${schemeId.toLowerCase()}`);
    const [schemeMembers, schemeProviders, schemeClaims] = await Promise.all([
      readCsvRecords(join(schemeDir, "members.csv")),
      readCsvRecords(join(schemeDir, "providers.csv")),
      readCsvRecords(join(schemeDir, "claims.csv")),
    ]);

    members.push(...normalizeSchemeRows(schemeId, schemeMembers, "member"));
    providers.push(...normalizeSchemeRows(schemeId, schemeProviders, "provider"));
    claims.push(...normalizeSchemeRows(schemeId, schemeClaims, "claim"));
  }

  return {
    schemes,
    members,
    providers,
    claims,
    summary: {
      schemes: schemes.length,
      members: members.length,
      providers: providers.length,
      claims: claims.length,
    },
  };
}

async function truncateTables(pool) {
  await pool.query("SET FOREIGN_KEY_CHECKS = 0");
  await pool.query("TRUNCATE TABLE claims");
  await pool.query("TRUNCATE TABLE providers");
  await pool.query("TRUNCATE TABLE members");
  await pool.query("TRUNCATE TABLE schemes");
  await pool.query("TRUNCATE TABLE ledger_entries");
  await pool.query("SET FOREIGN_KEY_CHECKS = 1");
}

async function insertRows(pool, tableName, rows, columns, batchSize = 1000) {
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    const placeholders = batch.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    const values = batch.flatMap((row) => columns.map((column) => {
      if (column === "payload") {
        return JSON.stringify(row[column]);
      }

      return row[column];
    }));
    await pool.query(`INSERT INTO ${tableName} (${columns.join(", ")}) VALUES ${placeholders}`, values);
  }
}

export async function seedSyntheticDatabase(pool, options = {}) {
  const sourceDir = options.sourceDir || defaultSourceDir;
  const applyMigrationsFirst = options.applyMigrationsFirst ?? true;

  if (applyMigrationsFirst) {
    await applyMigrations(pool, options.migrationPath);
  }

  const data = await loadSyntheticPhase1Data(sourceDir);

  await truncateTables(pool);

  await insertRows(pool, "schemes", data.schemes, ["scheme_id", "scheme_name"]);
  await insertRows(pool, "members", data.members, [
    "member_id",
    "scheme_id",
    "first_name",
    "last_name",
    "date_of_birth",
    "gender",
    "synthetic_id_number",
    "synthetic_banking_detail",
    "home_region",
    "home_lat",
    "home_lon",
    "join_date",
  ]);
  await insertRows(pool, "providers", data.providers, [
    "provider_id",
    "scheme_id",
    "practice_number",
    "specialty",
    "practice_name",
    "synthetic_banking_detail",
    "practice_region",
    "practice_lat",
    "practice_lon",
  ]);
  await insertRows(pool, "claims", data.claims, [
    "claim_id",
    "scheme_id",
    "member_id",
    "provider_id",
    "service_date",
    "billing_code",
    "amount",
  ]);

  const ledgerEntries = [];

  const seedEntry = createLedgerEntry({
    sequenceNumber: 1,
    previousHash: genesisPreviousHash,
    entryType: "DATA_SEEDED",
    payload: {
      source: "phase1-synthetic",
      summary: data.summary,
    },
  });

  ledgerEntries.push(seedEntry);

  try {
    const investigationPayload = await readJsonFile(join(sourceDir, "ground_truth", "investigation_reports.json"));
    const confirmedReports = (investigationPayload?.reports || [])
      .filter((report) => report.investigation_status === "CONFIRMED_FRAUD" && report.final_decision === "Fraud confirmed")
      .sort((left, right) => String(left.investigation_id).localeCompare(String(right.investigation_id)));

    let previousEntry = seedEntry;
    for (const report of confirmedReports) {
      const entry = createLedgerEntry({
        sequenceNumber: previousEntry.sequenceNumber + 1,
        previousHash: previousEntry.entryHash,
        entryType: "INVESTIGATOR_CONFIRMED_FRAUD",
        payload: {
          claimId: report.claim_id,
          investigatorId: report.investigator,
          schemeId: report.scheme_id,
          reportVersion: "synthetic-demo-v1",
          reason: report.evidence_summary,
          notes: `Synthetic case ${report.investigation_id}: ${report.scenario_type}`,
          decisionTimestamp: report.decision_date,
        },
      });

      ledgerEntries.push(entry);
      previousEntry = entry;
    }
  } catch {
    // Investigation artifacts are optional for backwards-compatible seed runs.
  }

  await insertRows(pool, "ledger_entries", ledgerEntries.map((entry) => ({
    sequence_number: entry.sequenceNumber,
    entry_type: entry.entryType,
    previous_hash: entry.previousHash,
    entry_hash: entry.entryHash,
    payload: entry.payload,
  })), [
    "sequence_number",
    "entry_type",
    "previous_hash",
    "entry_hash",
    "payload",
  ]);

  return data.summary;
}

export async function main(argv = process.argv.slice(2)) {
  if (process.env.OPERATIONAL_ADMIN_MODE !== "legacy_shared") {
    throw new Error("Operational seeding requires OPERATIONAL_ADMIN_MODE=legacy_shared.");
  }
  const databaseUrl = process.env.MYSQL_URL;
  if (!databaseUrl) {
    throw new Error("MYSQL_URL must be set to seed synthetic data");
  }

  const { createMysqlConnection } = await import("./client.js");
  const pool = createMysqlConnection(databaseUrl);

  try {
    const summary = await seedSyntheticDatabase(pool, {
      sourceDir: defaultSourceDir,
      applyMigrationsFirst: true,
    });

    console.log(`Seeded synthetic data: ${summary.members} members, ${summary.providers} providers, ${summary.claims} claims`);
  } finally {
    await pool.end();
  }
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  await main();
}
