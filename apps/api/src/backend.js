import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

import { createBackendHealth, createBackendInfo } from "@claimguard/shared-schema";

import { backendRouter, backendRouterPath } from "./trpc.js";

const genesisPreviousHash = "0".repeat(64);

function createLedgerEntry({ sequenceNumber, previousHash = genesisPreviousHash, entryType, payload }) {
  const digest = crypto.createHash("sha256");
  digest.update(previousHash);
  digest.update("|");
  digest.update(entryType);
  digest.update("|");
  digest.update(JSON.stringify(payload));

  return {
    sequenceNumber,
    entryType,
    previousHash,
    entryHash: digest.digest("hex"),
    payload,
  };
}

async function readDetectionReport(detectionReportPath) {
  if (!detectionReportPath) {
    return null;
  }

  const content = await readFile(detectionReportPath, "utf-8");
  return JSON.parse(content);
}

function stableToken(prefix, value) {
  const digest = crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
  return `${prefix}:${digest}`;
}

function normalizeClaims(rawClaims = []) {
  return [...rawClaims]
    .map((raw) => {
      const claimId = raw.claim_id || raw.claimId || stableToken("claim", JSON.stringify(raw));
      const claimantId = raw.claimant_id || raw.claimantId || raw.member_id || raw.memberId || "unknown-claimant";
      const providerId = raw.provider_id || raw.providerId || "unknown-provider";
      const phone = raw.phone || raw.phone_number || stableToken("phone", claimantId);
      const email = raw.email || stableToken("email", claimantId);
      const address = raw.address || raw.home_region || stableToken("address", claimantId);
      const bankAccount = raw.bank_account || raw.bankAccount || raw.synthetic_banking_detail || stableToken("bank", `${claimantId}:${providerId}`);
      const deviceId = raw.device_id || raw.deviceId || stableToken("device", `${claimantId}:${claimId}`);
      const ipAddress = raw.ip_address || raw.ipAddress || stableToken("ip", `${providerId}:${claimId}`);

      return {
        claimId: String(claimId),
        claimantId: String(claimantId),
        providerId: String(providerId),
        phone: String(phone),
        email: String(email),
        address: String(address),
        bankAccount: String(bankAccount),
        deviceId: String(deviceId),
        ipAddress: String(ipAddress),
      };
    })
    .sort((left, right) => `${left.claimantId}:${left.claimId}`.localeCompare(`${right.claimantId}:${right.claimId}`));
}

function buildDetectionPayloadFromClaims(rawClaims = [], ledgerReference = null) {
  const claims = normalizeClaims(rawClaims);
  const entities = new Map();
  const relationships = [];
  const claimCounts = new Map();

  const addEntity = (entityId, entityType, value) => {
    if (!entities.has(entityId)) {
      entities.set(entityId, {
        entity_id: entityId,
        entity_type: entityType,
        value,
      });
    }
  };

  const addObservedRelation = (source, target, claimId) => {
    relationships.push({
      relationship_type: "observed_with",
      source_entity_id: source,
      target_entity_id: target,
      claim_id: claimId,
    });
  };

  for (const claim of claims) {
    const claimantEntityId = `claimant:${claim.claimantId}`;
    const providerEntityId = `provider:${claim.providerId}`;
    const phoneEntityId = `phone:${claim.phone}`;
    const emailEntityId = `email:${claim.email}`;
    const addressEntityId = `address:${claim.address}`;
    const bankEntityId = `bank_account:${claim.bankAccount}`;
    const deviceEntityId = `device:${claim.deviceId}`;
    const ipEntityId = `ip:${claim.ipAddress}`;

    addEntity(claimantEntityId, "claimant", claim.claimantId);
    addEntity(providerEntityId, "provider", claim.providerId);
    addEntity(phoneEntityId, "phone", claim.phone);
    addEntity(emailEntityId, "email", claim.email);
    addEntity(addressEntityId, "address", claim.address);
    addEntity(bankEntityId, "bank_account", claim.bankAccount);
    addEntity(deviceEntityId, "device", claim.deviceId);
    addEntity(ipEntityId, "ip", claim.ipAddress);

    for (const target of [phoneEntityId, emailEntityId, addressEntityId, bankEntityId, deviceEntityId, ipEntityId, providerEntityId]) {
      addObservedRelation(claimantEntityId, target, claim.claimId);
    }

    claimCounts.set(claimantEntityId, (claimCounts.get(claimantEntityId) || 0) + 1);
  }

  const entityById = new Map(Array.from(entities.values()).map((entity) => [entity.entity_id, entity]));
  const artifactSharing = (entityType, ruleId, title, weight) => {
    const artifactToClaimants = new Map();
    for (const rel of relationships) {
      if (rel.relationship_type !== "observed_with") continue;
      const targetEntity = entityById.get(rel.target_entity_id);
      if (!targetEntity || targetEntity.entity_type !== entityType) continue;
      if (!artifactToClaimants.has(rel.target_entity_id)) artifactToClaimants.set(rel.target_entity_id, new Set());
      artifactToClaimants.get(rel.target_entity_id).add(rel.source_entity_id);
    }

    const hits = [];
    for (const artifactId of Array.from(artifactToClaimants.keys()).sort()) {
      const claimantsForArtifact = Array.from(artifactToClaimants.get(artifactId)).sort();
      if (claimantsForArtifact.length < 2) continue;
      hits.push({
        rule_id: ruleId,
        title,
        weight,
        evidence: [`${artifactId} linked to ${claimantsForArtifact.join(", ")}`],
      });
    }
    return hits;
  };

  const degree = new Map();
  for (const rel of relationships) {
    degree.set(rel.source_entity_id, (degree.get(rel.source_entity_id) || 0) + 1);
    degree.set(rel.target_entity_id, (degree.get(rel.target_entity_id) || 0) + 1);
  }

  const hits = [
    ...artifactSharing("device", "shared_devices", "Shared devices detected", 10),
    ...artifactSharing("address", "shared_addresses", "Shared addresses detected", 9),
    ...artifactSharing("bank_account", "reused_bank_accounts", "Reused bank accounts detected", 12),
    ...artifactSharing("phone", "reused_phone_numbers", "Reused phone numbers detected", 8),
    ...artifactSharing("email", "reused_emails", "Reused emails detected", 7),
  ];

  for (const [claimantId, count] of Array.from(claimCounts.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    if (count < 3) continue;
    hits.push({
      rule_id: "repeat_offenders",
      title: "Repeat offenders detected",
      weight: 8,
      evidence: [`${claimantId} appears in ${count} claims`],
    });
  }

  for (const [entityId, count] of Array.from(degree.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    if (count < 4) continue;
    hits.push({
      rule_id: "unusually_connected_entities",
      title: "Unusually connected entities detected",
      weight: 8,
      evidence: [`${entityId} has graph degree ${count}`],
    });
  }

  const weightedScore = hits.reduce((sum, hit) => sum + hit.weight, 0);
  const riskScore = Math.min(100, weightedScore);
  const severity = riskScore >= 70 ? "High" : riskScore >= 40 ? "Medium" : "Low";

  const graphSummary = {
    entity_count: entities.size,
    relationship_count: relationships.length,
    claimant_count: Array.from(entities.values()).filter((entity) => entity.entity_type === "claimant").length,
    max_degree: Math.max(0, ...degree.values()),
  };

  return {
    entities: Array.from(entities.values()).sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
    relationships: [...relationships].sort((left, right) => `${left.source_entity_id}:${left.target_entity_id}:${left.claim_id}`.localeCompare(`${right.source_entity_id}:${right.target_entity_id}:${right.claim_id}`)),
    triggered_rules: hits.sort((left, right) => `${left.rule_id}:${left.evidence[0] || ""}`.localeCompare(`${right.rule_id}:${right.evidence[0] || ""}`)),
    risk_score: {
      riskScore,
      severity,
      reasons: hits.length ? hits.map((hit) => `${hit.title}: ${hit.evidence.join("; ")}`) : ["No detection rules were triggered"],
    },
    evidence: hits.flatMap((hit) => hit.evidence),
    graph_summary: graphSummary,
    ledger_reference: ledgerReference,
  };
}

async function loadReportOrFail(detectionReportPath) {
  try {
    const report = await readDetectionReport(detectionReportPath);
    if (!report) {
      return {
        ok: false,
        status: 503,
        body: {
          available: false,
          message: "DETECTION_REPORT_PATH is not configured, so the detection report is not available yet.",
        },
      };
    }

    return {
      ok: true,
      report,
    };
  } catch {
    return {
      ok: false,
      status: 503,
      body: {
        available: false,
        message: "The configured detection report could not be read yet.",
      },
    };
  }
}

export function createBackendApp({ ledgerRepository = null, detectionReportPath = null } = {}) {
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json(createBackendHealth());
  });

  app.get("/meta", (c) => {
    return c.json(createBackendInfo());
  });

  app.get("/ledger/preview", (c) => {
    const entry = createLedgerEntry({
      sequenceNumber: 1,
      previousHash: genesisPreviousHash,
      entryType: "API_BOOT",
      payload: {
        service: "api",
        phase: "3",
      },
    });

    return c.json({
      chainReady: true,
      entry,
    });
  });

  app.get("/ledger/latest", async (c) => {
    if (!ledgerRepository) {
      return c.json(
        {
          available: false,
          message: "MYSQL_URL is not configured, so the runtime ledger is not available yet.",
        },
        503,
      );
    }

    const latestEntry = await ledgerRepository.getLatestEntry();

    if (!latestEntry) {
      return c.json({ available: true, entry: null }, 200);
    }

    return c.json({ available: true, entry: latestEntry }, 200);
  });

  app.get("/detection/report", async (c) => {
    const loaded = await loadReportOrFail(detectionReportPath);
    if (!loaded.ok) {
      return c.json(loaded.body, loaded.status);
    }

    return c.json({ available: true, report: loaded.report }, 200);
  });

  app.get("/detection/graph", async (c) => {
    const loaded = await loadReportOrFail(detectionReportPath);
    if (!loaded.ok) {
      return c.json(loaded.body, loaded.status);
    }

    const graph = loaded.report?.detection?.graph_summary
      ? {
          summary: loaded.report.detection.graph_summary,
          entities: loaded.report.detection.entities || [],
          relationships: loaded.report.detection.relationships || [],
        }
      : {
          summary: {
            entity_count: (loaded.report.network?.network_nodes || []).length,
            relationship_count:
              (loaded.report.network?.exact_banking_links || []).length +
              (loaded.report.network?.behavioral_provider_links || []).length,
          },
          entities: loaded.report.network?.network_nodes || [],
          relationships: [
            ...(loaded.report.network?.exact_banking_links || []),
            ...(loaded.report.network?.behavioral_provider_links || []),
          ],
        };

    return c.json({ available: true, graph }, 200);
  });

  app.get("/detection/risk", async (c) => {
    const loaded = await loadReportOrFail(detectionReportPath);
    if (!loaded.ok) {
      return c.json(loaded.body, loaded.status);
    }

    const risk = loaded.report?.detection?.risk_score || {
      riskScore: 0,
      severity: "Low",
      reasons: ["Detection risk is unavailable in the current report."],
    };

    return c.json({ available: true, risk }, 200);
  });

  app.post("/detection/analyze", async (c) => {
    const payload = await c.req.json().catch(() => null);
    if (!payload || !Array.isArray(payload.claims)) {
      return c.json(
        {
          available: false,
          message: "Request body must include a claims array.",
        },
        400,
      );
    }

    const detection = buildDetectionPayloadFromClaims(payload.claims, payload.ledger_reference || null);
    return c.json({ available: true, detection }, 200);
  });

  app.all(`${backendRouterPath}/*`, (c) => {
    return fetchRequestHandler({
      endpoint: backendRouterPath,
      req: c.req.raw,
      router: backendRouter,
      createContext: async () => ({
        requestId: c.req.header("x-request-id") || null,
      }),
    });
  });

  return app;
}