import assert from "node:assert/strict";
import test from "node:test";

import { createLiveDemoSimulator } from "../src/simulation/live-demo-simulator.js";

function createCatalog() {
  return [
    {
      tenant_id: "tenant_alpha",
      tenant_name: "Discovery Health",
      schemes: ["scheme_a"],
      members: [
        { member_id: "M-A-001", scheme_id: "scheme_a", home_region: "Gauteng" },
        { member_id: "M-A-002", scheme_id: "scheme_a", home_region: "Gauteng" },
        { member_id: "M-A-003", scheme_id: "scheme_a", home_region: "Western Cape" },
      ],
      providers: [
        { provider_id: "P-A-001", scheme_id: "scheme_a", specialty: "GENERAL_PRACTITIONER", synthetic_banking_detail: "BANK-A-1" },
        { provider_id: "P-A-002", scheme_id: "scheme_a", specialty: "PHARMACY", synthetic_banking_detail: "BANK-A-2" },
        { provider_id: "P-A-003", scheme_id: "scheme_a", specialty: "PATHOLOGIST", synthetic_banking_detail: "BANK-A-3" },
      ],
    },
    {
      tenant_id: "tenant_beta",
      tenant_name: "Momentum Health",
      schemes: ["scheme_b"],
      members: [
        { member_id: "M-B-001", scheme_id: "scheme_b", home_region: "KwaZulu-Natal" },
        { member_id: "M-B-002", scheme_id: "scheme_b", home_region: "Eastern Cape" },
      ],
      providers: [
        { provider_id: "P-B-001", scheme_id: "scheme_b", specialty: "HOSPITAL", synthetic_banking_detail: "BANK-B-1" },
        { provider_id: "P-B-002", scheme_id: "scheme_b", specialty: "SPECIALIST", synthetic_banking_detail: "BANK-B-2" },
      ],
    },
  ];
}

function createMockApiClient(catalog) {
  const tenantToSchemes = new Map(catalog.map((tenant) => [tenant.tenant_id, new Set(tenant.schemes)]));

  const state = {
    calls: [],
    claims: [],
    claimsByTenant: new Map(),
    investigations: new Map(),
    investigationHistory: new Map(),
    notes: [],
    evidence: [],
    confirmations: [],
    reversals: [],
    registry: [],
  };

  let investigationCounter = 0;

  function pushClaim(tenantId, claim) {
    if (!state.claimsByTenant.has(tenantId)) {
      state.claimsByTenant.set(tenantId, []);
    }
    state.claimsByTenant.get(tenantId).push(claim);
    state.claims.push({ tenantId, ...claim });
  }

  function ensureTransitionAllowed(from, to) {
    const transitions = {
      OPEN: ["UNDER_REVIEW", "AWAITING_EVIDENCE", "CLOSED"],
      UNDER_REVIEW: ["AWAITING_EVIDENCE", "CONFIRMED_FRAUD", "NO_FRAUD_FOUND", "CLOSED"],
      AWAITING_EVIDENCE: ["UNDER_REVIEW", "CLOSED"],
      CONFIRMED_FRAUD: ["CLOSED"],
      NO_FRAUD_FOUND: ["CLOSED"],
      CLOSED: [],
    };

    return transitions[from]?.includes(to) === true;
  }

  return {
    state,
    async request({ path, method = "GET", headers = {}, body = null }) {
      const tenantId = headers["x-claimguard-user-tenant"];
      state.calls.push({ path, method, tenantId, body });

      if (path === "/claims/ingest" && method === "POST") {
        const claims = body?.claims || [];
        const schemes = tenantToSchemes.get(tenantId) || new Set();
        for (const claim of claims) {
          assert.equal(claim.tenant_id, tenantId);
          assert.equal(schemes.has(claim.scheme_id), true);
          pushClaim(tenantId, claim);
        }

        return {
          status: 202,
          json: {
            available: true,
            ingestion: {
              received: claims.length,
              inserted: claims.length,
              updated: 0,
              source: body?.source || "live-demo",
            },
          },
        };
      }

      if (path === "/investigations" && method === "POST") {
        const claimId = body?.claimId;
        const claim = (state.claimsByTenant.get(tenantId) || []).find((entry) => entry.claim_id === claimId);
        if (!claim) {
          return {
            status: 404,
            json: {
              available: false,
              message: "Claim not found for tenant.",
            },
          };
        }

        investigationCounter += 1;
        const investigationId = `INV-${String(investigationCounter).padStart(5, "0")}`;
        const investigation = {
          investigationId,
          tenantId,
          claimId,
          status: "OPEN",
        };

        state.investigations.set(investigationId, investigation);
        state.investigationHistory.set(investigationId, ["OPEN"]);

        return {
          status: 201,
          json: {
            available: true,
            investigation,
          },
        };
      }

      if (path.startsWith("/investigations/") && path.endsWith("/notes") && method === "POST") {
        const investigationId = path.split("/")[2];
        const investigation = state.investigations.get(investigationId);
        if (!investigation || investigation.tenantId !== tenantId) {
          return {
            status: 404,
            json: { available: false },
          };
        }

        state.notes.push({ investigationId, tenantId, text: body?.text || "" });
        return {
          status: 201,
          json: {
            available: true,
            note: {
              investigationId,
              text: body?.text || "",
            },
          },
        };
      }

      if (path.startsWith("/investigations/") && path.endsWith("/evidence") && method === "POST") {
        const investigationId = path.split("/")[2];
        const investigation = state.investigations.get(investigationId);
        if (!investigation || investigation.tenantId !== tenantId) {
          return {
            status: 404,
            json: { available: false },
          };
        }

        state.evidence.push({ investigationId, tenantId, filename: body?.filename || "" });
        return {
          status: 201,
          json: {
            available: true,
            evidence: {
              investigationId,
              filename: body?.filename || "",
            },
          },
        };
      }

      if (path.startsWith("/investigations/") && method === "PATCH") {
        const investigationId = path.split("/")[2];
        const investigation = state.investigations.get(investigationId);
        if (!investigation || investigation.tenantId !== tenantId) {
          return {
            status: 404,
            json: { available: false },
          };
        }

        const nextStatus = body?.status;
        if (typeof nextStatus === "string" && nextStatus !== investigation.status) {
          assert.equal(ensureTransitionAllowed(investigation.status, nextStatus), true);
          investigation.status = nextStatus;
          state.investigationHistory.get(investigationId).push(nextStatus);
        }

        return {
          status: 200,
          json: {
            available: true,
            investigation,
          },
        };
      }

      if (path === "/investigations/confirm-fraud" && method === "POST") {
        const investigationId = body?.investigationId;
        const investigation = state.investigations.get(investigationId);

        if (!investigation || investigation.tenantId !== tenantId) {
          return {
            status: 404,
            json: { available: false },
          };
        }

        if (investigation.status !== "CONFIRMED_FRAUD") {
          return {
            status: 409,
            json: { available: false },
          };
        }

        const entry = {
          entryType: "INVESTIGATOR_CONFIRMED_FRAUD",
          payload: {
            claimId: body?.claimId,
          },
        };

        const registryEntry = {
          registryEntryId: `REG-${state.registry.length + 1}`,
          investigationId,
          tenantId,
          status: "ACTIVE",
          subjectToken: body?.registryMetadata?.subjectToken || `token:${investigation.claimId}`,
        };

        state.confirmations.push({ investigationId, tenantId });
        state.registry.push(registryEntry);

        return {
          status: 201,
          json: {
            available: true,
            entry,
            registryEntry,
          },
        };
      }

      if (path === "/investigations/reverse-fraud" && method === "POST") {
        const investigationId = body?.investigationId;
        const investigation = state.investigations.get(investigationId);
        if (!investigation || investigation.tenantId !== tenantId) {
          return {
            status: 404,
            json: { available: false },
          };
        }

        const active = state.registry.find(
          (entry) =>
            entry.investigationId === investigationId &&
            entry.tenantId === tenantId &&
            entry.status === "ACTIVE" &&
            !state.registry.some((candidate) => candidate.reversesRegistryEntryId === entry.registryEntryId),
        );

        if (!active) {
          return {
            status: 409,
            json: { available: false },
          };
        }

        const entry = {
          entryType: "INVESTIGATOR_REVERSED_FRAUD",
          payload: {
            claimId: body?.claimId,
          },
        };

        const registryEntry = {
          registryEntryId: `REG-${state.registry.length + 1}`,
          investigationId,
          tenantId,
          status: "REVERSED",
          reversesRegistryEntryId: active.registryEntryId,
          subjectToken: active.subjectToken,
        };

        state.reversals.push({ investigationId, tenantId });
        state.registry.push(registryEntry);

        return {
          status: 201,
          json: {
            available: true,
            entry,
            registryEntry,
          },
        };
      }

      if (path.startsWith("/registry/search") && method === "GET") {
        return {
          status: 200,
          json: {
            available: true,
            results: state.registry.filter((entry) => entry.status === "ACTIVE"),
          },
        };
      }

      return {
        status: 404,
        json: {
          available: false,
        },
      };
    },
  };
}

async function createSimulatorHarness({ enabled, seed = 42, mode = null, staticMode = false, storyMode = "" }) {
  const catalog = createCatalog();
  const apiClient = createMockApiClient(catalog);
  const resolvedMode = mode || (enabled ? "on" : "off");

  const simulator = createLiveDemoSimulator({
    enabled,
    mode: resolvedMode,
    staticMode,
    storyMode,
    seed,
    tickIntervalMs: 60_000,
    maxActiveInvestigations: 200,
    bootstrap: {
      async loadCatalog() {
        return catalog;
      },
    },
    apiClient,
    timelineConfig: {
      startAt: "2026-01-01T08:00:00.000Z",
    },
  });

  await simulator.start();
  simulator.stop();

  return {
    simulator,
    apiClient,
  };
}

test("live demo OFF produces no activity", async () => {
  const { simulator, apiClient } = await createSimulatorHarness({ enabled: false, seed: 41 });

  await simulator.runTick();
  await simulator.runTick();

  const snapshot = simulator.getSnapshot();
  assert.equal(snapshot.stats.claimsGenerated, 0);
  assert.equal(snapshot.stats.investigationsCreated, 0);
  assert.equal(snapshot.stats.registryUpdates, 0);
  assert.equal(apiClient.state.calls.length, 0);
});

test("live demo ON generates healthcare activity", async () => {
  const { simulator } = await createSimulatorHarness({ enabled: true, seed: 99 });

  for (let index = 0; index < 90; index += 1) {
    await simulator.runTick();
  }

  const snapshot = simulator.getSnapshot();
  assert.equal(snapshot.stats.claimsGenerated > 0, true);
  assert.equal(snapshot.stats.investigationsCreated > 0, true);
  assert.equal(snapshot.stats.relationshipUpdates > 0, true);
});

test("generated claims remain tenant-isolated", async () => {
  const { simulator, apiClient } = await createSimulatorHarness({ enabled: true, seed: 123 });

  for (let index = 0; index < 70; index += 1) {
    await simulator.runTick();
  }

  const schemeToTenant = new Map([
    ["scheme_a", "tenant_alpha"],
    ["scheme_b", "tenant_beta"],
  ]);

  for (const claim of apiClient.state.claims) {
    assert.equal(claim.tenantId, schemeToTenant.get(claim.scheme_id));
    assert.equal(claim.tenant_id, claim.tenantId);
  }
});

test("registry contains only confirmed fraud outcomes", async () => {
  const { simulator, apiClient } = await createSimulatorHarness({ enabled: true, seed: 777 });

  for (let index = 0; index < 120; index += 1) {
    await simulator.runTick();
  }

  const confirmedInvestigationIds = new Set(apiClient.state.confirmations.map((entry) => entry.investigationId));

  for (const entry of apiClient.state.registry) {
    if (entry.status === "ACTIVE") {
      assert.equal(confirmedInvestigationIds.has(entry.investigationId), true);
    }

    if (entry.status === "REVERSED") {
      assert.equal(Boolean(entry.reversesRegistryEntryId), true);
    }
  }
});

test("investigations follow valid lifecycle transitions", async () => {
  const { simulator, apiClient } = await createSimulatorHarness({ enabled: true, seed: 2026 });

  for (let index = 0; index < 110; index += 1) {
    await simulator.runTick();
  }

  const allowed = {
    OPEN: new Set(["UNDER_REVIEW", "AWAITING_EVIDENCE", "CLOSED"]),
    UNDER_REVIEW: new Set(["AWAITING_EVIDENCE", "CONFIRMED_FRAUD", "NO_FRAUD_FOUND", "CLOSED"]),
    AWAITING_EVIDENCE: new Set(["UNDER_REVIEW", "CLOSED"]),
    CONFIRMED_FRAUD: new Set(["CLOSED"]),
    NO_FRAUD_FOUND: new Set(["CLOSED"]),
    CLOSED: new Set(),
  };

  for (const history of apiClient.state.investigationHistory.values()) {
    for (let index = 1; index < history.length; index += 1) {
      const from = history[index - 1];
      const to = history[index];
      assert.equal(allowed[from].has(to), true);
    }
  }
});

test("simulation is deterministic with fixed seed", async () => {
  const first = await createSimulatorHarness({ enabled: true, seed: 11 });
  const second = await createSimulatorHarness({ enabled: true, seed: 11 });

  for (let index = 0; index < 85; index += 1) {
    await first.simulator.runTick();
    await second.simulator.runTick();
  }

  const firstSnapshot = first.simulator.getSnapshot();
  const secondSnapshot = second.simulator.getSnapshot();

  assert.deepEqual(firstSnapshot.stats, secondSnapshot.stats);
  assert.deepEqual(firstSnapshot.activityTail, secondSnapshot.activityTail);
});

test("story mode produces reproducible named scenarios", async () => {
  const first = await createSimulatorHarness({
    enabled: true,
    seed: 314,
    storyMode: "provider_collusion,identity_theft",
  });
  const second = await createSimulatorHarness({
    enabled: true,
    seed: 314,
    storyMode: "provider_collusion,identity_theft",
  });

  for (let index = 0; index < 75; index += 1) {
    await first.simulator.runTick();
    await second.simulator.runTick();
  }

  const firstSnapshot = first.simulator.getSnapshot();
  const secondSnapshot = second.simulator.getSnapshot();

  assert.equal(firstSnapshot.stories.length > 0, true);
  assert.deepEqual(firstSnapshot.stories, secondSnapshot.stories);
  assert.deepEqual(firstSnapshot.activityTail, secondSnapshot.activityTail);
});

test("static mode remains deterministic while API checks continue", async () => {
  const { simulator, apiClient } = await createSimulatorHarness({
    enabled: true,
    mode: "static",
    staticMode: true,
    seed: 808,
    storyMode: "duplicate_mri_billing",
  });

  for (let index = 0; index < 60; index += 1) {
    await simulator.runTick();
  }

  const snapshot = simulator.getSnapshot();
  assert.equal(snapshot.mode, "static");
  assert.equal(snapshot.staticMode, true);
  assert.equal(snapshot.stats.apiCalls > 0, true);
  assert.equal(apiClient.state.calls.length > 0, true);
});
