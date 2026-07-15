import crypto from "node:crypto";
import { createStoryEngine } from "./story-mode.js";
import { createTimelineScheduler } from "./agents/timeline-scheduler.js";
import { createMemberBehaviourAgent } from "./agents/member-behaviour-agent.js";
import { createProviderBehaviourAgent } from "./agents/provider-behaviour-agent.js";
import { createClaimSubmissionAgent } from "./agents/claim-submission-agent.js";
import { createFraudAnalystAgent } from "./agents/fraud-analyst-agent.js";
import { createInvestigatorAgent } from "./agents/investigator-agent.js";
import { createApplicationsCommitteeAgent } from "./agents/applications-committee-agent.js";

const DEFAULT_TICK_INTERVAL_MS = 8_000;
const DEFAULT_MAX_RECENT_CLAIMS = 500;
const DEFAULT_FRAUD_RATE = 0.04;

const PROVIDER_SPECIALTIES = [
  "GENERAL_PRACTITIONER",
  "HOSPITAL",
  "DENTIST",
  "PHYSIOTHERAPIST",
  "PATHOLOGIST",
  "RADIOLOGIST",
  "PHARMACY",
  "SPECIALIST",
];

const BILLING_CODES = {
  consultation: ["CONSULT_GP", "CONSULT_SPECIALIST", "CHECKUP", "VACCINATION"],
  pathology: ["PATH_LIPID", "PATH_HBA1C", "PATH_CBC", "PATH_THYROID"],
  pharmacy: ["RX_CHRONIC", "RX_ACUTE", "RX_ANTIBIOTIC", "RX_CONTROLLED"],
  hospital: ["HOSP_ADMISSION", "ER_VISIT", "WARD_DAY", "SURGERY_MINOR"],
  referral: ["REF_SPECIALIST", "REF_PHYSIO", "REF_RAD"],
};

const FRAUD_SCENARIOS = [
  { key: "duplicate_billing", offenceCategory: "Duplicate Billing", reason: "Duplicate billing pattern observed for same-day services." },
  { key: "ghost_patient", offenceCategory: "Ghost Patient", reason: "Ghost patient indicators detected from repeated synthetic identity links." },
  { key: "provider_collusion", offenceCategory: "Provider Collusion", reason: "Collusive provider relationship pattern detected in claim network." },
  { key: "identity_reuse", offenceCategory: "Identity Reuse", reason: "Identity reuse pattern detected across disconnected services." },
  { key: "procedure_inflation", offenceCategory: "Procedure Inflation", reason: "Procedure inflation pattern detected relative to expected norms." },
  { key: "excessive_pathology", offenceCategory: "Excessive Pathology", reason: "Excessive pathology ordering pattern detected." },
  { key: "prescription_abuse", offenceCategory: "Prescription Abuse", reason: "Prescription abuse pattern detected with controlled medication clusters." },
  { key: "doctor_shopping", offenceCategory: "Doctor Shopping", reason: "Doctor shopping pattern detected across providers." },
  { key: "impossible_travel", offenceCategory: "Impossible Travel", reason: "Impossible travel pattern detected for claim timeline." },
  { key: "network_collusion", offenceCategory: "Network Collusion", reason: "Network collusion pattern detected between claimant and provider cluster." },
  { key: "recovered_provider", offenceCategory: "Recovered Fraud Provider", reason: "Recovered fraudulent provider resumed suspicious billing patterns." },
  { key: "repeat_offender", offenceCategory: "Repeat Offender", reason: "Repeat offender behavior observed across prior case history." },
];

const MEMBER_UTILIZATION_PROFILES = ["normal", "frequent_claimant", "chronic", "doctor_shopper", "high_utilization"];
const MEMBER_BEHAVIORS = ["normal", "frequent_claimant", "doctor_shopper", "identity_misuse", "collusive"];
const PROVIDER_RISK_PROFILES = ["honest", "aggressive", "suspicious", "fraudulent"];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function inListQueryPlaceholders(values) {
  return values.map(() => "?").join(", ");
}

class SeededRandom {
  constructor(seed = 42) {
    this.state = seed >>> 0;
    if (this.state === 0) {
      this.state = 1;
    }
  }

  next() {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  int(min, max) {
    if (max <= min) {
      return min;
    }
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  chance(probability) {
    return this.next() < probability;
  }

  pick(values) {
    if (!Array.isArray(values) || values.length === 0) {
      return null;
    }
    return values[this.int(0, values.length - 1)];
  }
}

function normalizeSimulationMode(value) {
  return String(value || "off").trim().toLowerCase();
}

export function parseLiveDemoConfigFromEnvironment(env = process.env) {
  const mode = normalizeSimulationMode(env.LIVE_DEMO_MODE);
  const configuredTenants = String(env.LIVE_DEMO_TENANTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    mode,
    enabled: mode === "on" || mode === "static",
    staticMode: mode === "static",
    tickIntervalMs: clamp(Number(env.LIVE_DEMO_TICK_MS || DEFAULT_TICK_INTERVAL_MS), 1000, 300000),
    seed: Number(env.LIVE_DEMO_SEED || 42),
    configuredTenantIds: configuredTenants,
    maxRecentClaims: clamp(Number(env.LIVE_DEMO_MAX_RECENT_CLAIMS || DEFAULT_MAX_RECENT_CLAIMS), 100, 5000),
    maxActiveInvestigations: clamp(Number(env.LIVE_DEMO_MAX_ACTIVE_INVESTIGATIONS || 800), 50, 8000),
    storyMode: String(env.LIVE_DEMO_STORY_MODE || ""),
    fraudRate: clamp(Number(env.LIVE_DEMO_FRAUD_RATE || DEFAULT_FRAUD_RATE), 0.02, 0.05),
  };
}

function deriveTenantPersona(tenantName, random) {
  const normalized = String(tenantName || "").toLowerCase();

  if (normalized.includes("discovery")) {
    return {
      demographics: "large_population",
      chronicBurden: "medium",
      claimVolumeWeight: 1.4,
      specialistDensity: 1.3,
    };
  }

  if (normalized.includes("bonitas")) {
    return {
      demographics: "older_population",
      chronicBurden: "high",
      claimVolumeWeight: 1.2,
      specialistDensity: 1.1,
    };
  }

  if (normalized.includes("momentum")) {
    return {
      demographics: "younger_population",
      chronicBurden: "low",
      claimVolumeWeight: 0.9,
      specialistDensity: 1.0,
    };
  }

  return {
    demographics: "mixed_population",
    chronicBurden: random.pick(["low", "medium", "high"]),
    claimVolumeWeight: Number((0.9 + random.next() * 0.5).toFixed(2)),
    specialistDensity: Number((0.9 + random.next() * 0.5).toFixed(2)),
  };
}

function toIsoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function defaultTimeline(config = {}) {
  const start = new Date(config.startAt || "2026-01-01T08:00:00.000Z");
  return {
    now: start,
    advance(random) {
      const hourStep = random.int(4, 18);
      this.now = new Date(this.now.getTime() + hourStep * 60 * 60 * 1000);
      return this.now;
    },
    current() {
      return this.now;
    },
  };
}

function pickProvince(random) {
  const provinces = [
    "Gauteng",
    "Western Cape",
    "KwaZulu-Natal",
    "Free State",
    "Eastern Cape",
    "Limpopo",
    "Mpumalanga",
    "North West",
    "Northern Cape",
  ];
  return random.pick(provinces);
}

function specialtyToClaimFamily(specialty) {
  const normalized = String(specialty || "").toUpperCase();
  if (normalized.includes("PHARM")) {
    return "pharmacy";
  }
  if (normalized.includes("PATH")) {
    return "pathology";
  }
  if (normalized.includes("RADIO")) {
    return "pathology";
  }
  if (normalized.includes("HOSP")) {
    return "hospital";
  }
  if (normalized.includes("SPECIAL")) {
    return "referral";
  }
  return "consultation";
}

function createHeaders({ tenantId, userId, role }) {
  return {
    "content-type": "application/json",
    "x-claimguard-user": userId,
    "x-claimguard-role": role,
    "x-claimguard-user-tenant": tenantId,
    "x-claimguard-tenant": tenantId,
  };
}

function createRegistryMetadata({ tenant, claim, scenario, investigatorId, timelineDate }) {
  const subjectType = scenario.key === "identity_reuse" || scenario.key === "doctor_shopping" ? "MEMBER" : "PROVIDER";
  const subjectToken =
    subjectType === "MEMBER"
      ? `member:${claim.member_id}`
      : `provider:${claim.provider_id}`;

  return {
    medicalScheme: tenant.name,
    fraudSubjectType: subjectType,
    subjectToken,
    offenceCategory: scenario.offenceCategory,
    findingDate: timelineDate,
    investigatorReference: investigatorId,
  };
}

function createClaimTimestamp(timelineNow, random) {
  const lookbackDays = random.int(0, 35);
  const lookbackHours = random.int(0, 23);
  const date = new Date(timelineNow.getTime() - lookbackDays * 24 * 60 * 60 * 1000 - lookbackHours * 60 * 60 * 1000);
  return toIsoDate(date);
}

function nextClaimId({ tenantId, tickNumber, sequence }) {
  const compactTenant = String(tenantId || "tenant").replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase() || "TENANT";
  return `SIM-${compactTenant}-${String(tickNumber).padStart(5, "0")}-${String(sequence).padStart(4, "0")}`;
}

function hashToNumber(input) {
  const digest = crypto.createHash("sha256").update(String(input)).digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16);
}

function buildMemberProfile(memberId) {
  const hashed = hashToNumber(memberId);
  return {
    utilization: MEMBER_UTILIZATION_PROFILES[hashed % MEMBER_UTILIZATION_PROFILES.length],
    behavior: MEMBER_BEHAVIORS[(hashed >> 3) % MEMBER_BEHAVIORS.length],
    chronic: Boolean((hashed >> 6) % 2),
    dependants: (hashed >> 7) % 4,
  };
}

function buildProviderProfile(providerId) {
  const hashed = hashToNumber(providerId);
  return {
    riskProfile: PROVIDER_RISK_PROFILES[hashed % PROVIDER_RISK_PROFILES.length],
    networkAffinity: (hashed % 100) / 100,
    normalWorkload: 20 + ((hashed >> 5) % 80),
  };
}

function allowedTransition(from, to) {
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

function createTenantState(tenant, random) {
  const members = tenant.members.map((member) => ({
    ...member,
    profile: buildMemberProfile(member.member_id),
  }));

  const providers = tenant.providers.map((provider) => ({
    ...provider,
    profile: buildProviderProfile(provider.provider_id),
  }));

  return {
    tenantId: tenant.tenant_id,
    tenantName: tenant.tenant_name,
    persona: deriveTenantPersona(tenant.tenant_name, random),
    schemes: [...tenant.schemes],
    members,
    providers,
    activeInvestigations: new Map(),
    recentFraudCandidates: [],
    providerRelationshipVersion: 0,
    relationshipUpdates: 0,
    lastSeenMemberIds: new Set(),
    lastSeenProviderIds: new Set(),
    randomWeight: random.int(1, 100),
    agents: {
      member: null,
      provider: null,
    },
  };
}

export function createLiveDemoSimulator({
  enabled = false,
  mode = "off",
  staticMode = false,
  seed = 42,
  tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
  maxRecentClaims = DEFAULT_MAX_RECENT_CLAIMS,
  maxActiveInvestigations = 800,
  storyMode = "",
  fraudRate = DEFAULT_FRAUD_RATE,
  apiClient,
  bootstrap,
  logger,
  timelineConfig,
} = {}) {
  const random = new SeededRandom(seed);
  const timeline = defaultTimeline(timelineConfig);
  const storyEngine = createStoryEngine({ storyMode });
  const scheduler = createTimelineScheduler({ random, staticMode });

  let timer = null;
  let running = false;
  let tickNumber = 0;
  let claimSequence = 0;
  let tenantStates = new Map();
  const agentRuntime = {
    claimSubmission: null,
    fraudAnalyst: null,
    investigator: null,
    committee: null,
  };

  const stats = {
    ticks: 0,
    claimsGenerated: 0,
    investigationsCreated: 0,
    investigationsClosed: 0,
    fraudConfirmed: 0,
    fraudReversed: 0,
    registryUpdates: 0,
    relationshipUpdates: 0,
    apiCalls: 0,
  };

  const activityLog = [];

  function log(level, event, details = {}) {
    if (typeof logger === "function") {
      logger(level, event, details);
    }
  }

  function pushActivity(event) {
    activityLog.push(event);
    if (activityLog.length > 4000) {
      activityLog.shift();
    }
  }

  async function apiRequest({ path, method = "GET", tenantId, role, userId, body = null }) {
    if (!apiClient || typeof apiClient.request !== "function") {
      throw new Error("Live demo simulator requires an apiClient.request implementation.");
    }

    stats.apiCalls += 1;

    return apiClient.request({
      path,
      method,
      headers: createHeaders({ tenantId, role, userId }),
      body,
    });
  }

  function pickTenantState() {
    const values = [...tenantStates.values()];
    if (values.length === 0) {
      return null;
    }

    const weighted = values.map((value) => ({
      value,
      weight: Math.max(1, Math.floor((value.persona?.claimVolumeWeight || 1) * 100)) + value.randomWeight,
    }));

    const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    let threshold = random.next() * total;
    for (const entry of weighted) {
      threshold -= entry.weight;
      if (threshold <= 0) {
        return entry.value;
      }
    }

    return weighted[weighted.length - 1]?.value || null;
  }

  function selectClaimFamily(member, provider, claimFamilyHint = null) {
    if (claimFamilyHint) {
      return claimFamilyHint;
    }

    if (member.profile.chronic && random.chance(0.35)) {
      return "pharmacy";
    }

    if (member.profile.utilization === "high_utilization" && random.chance(0.2)) {
      return "hospital";
    }

    if (member.profile.behavior === "doctor_shopper" && random.chance(0.2)) {
      return "referral";
    }

    return specialtyToClaimFamily(provider.specialty);
  }

  function buildClaimForTenant(tenantState, timelineNow, options = {}) {
    const member = options.member || random.pick(tenantState.members);
    if (!member) {
      return null;
    }

    const providerPool = tenantState.providers.filter((entry) => entry.scheme_id === member.scheme_id);
    const provider = options.provider || random.pick(providerPool);

    if (!member || !provider) {
      return null;
    }

    claimSequence += 1;
    const claimFamily = selectClaimFamily(member, provider, options.claimFamilyHint || null);
    const billingCode = random.pick(BILLING_CODES[claimFamily] || BILLING_CODES.consultation);
    const amountBase =
      claimFamily === "hospital"
        ? random.int(4000, 22000)
        : claimFamily === "pathology"
          ? random.int(450, 2400)
          : claimFamily === "pharmacy"
            ? random.int(180, 1600)
            : random.int(250, 4200);

    const scenario = options.scenario || (random.chance(fraudRate) ? random.pick(FRAUD_SCENARIOS) : null);
    const amount = scenario && scenario.key === "procedure_inflation" ? amountBase * random.int(2, 4) : amountBase;

    const claim = {
      claim_id: nextClaimId({ tenantId: tenantState.tenantId, tickNumber, sequence: claimSequence }),
      scheme_id: member.scheme_id,
      member_id: member.member_id,
      provider_id: provider.provider_id,
      service_date: createClaimTimestamp(timelineNow, random),
      billing_code: billingCode,
      amount: Number(amount.toFixed ? amount.toFixed(2) : amount),
      phone: `+27${String(hashToNumber(member.member_id) % 900000000 + 100000000)}`,
      email: `${String(member.member_id).toLowerCase()}@demo.claimguard.local`,
      address: member.home_region || pickProvince(random),
      bank_account: provider.synthetic_banking_detail || `SIMBANK-${provider.provider_id}`,
      device_id: `device-${member.member_id}`,
      ip_address: `10.${random.int(1, 250)}.${random.int(1, 250)}.${random.int(1, 250)}`,
      tenant_id: tenantState.tenantId,
      _sim: {
        scenario,
        story: options.story || null,
        memberIntent: options.memberIntent || null,
        providerIntent: options.providerIntent || null,
        member,
        provider,
      },
    };

    tenantState.lastSeenMemberIds.add(member.member_id);
    tenantState.lastSeenProviderIds.add(provider.provider_id);

    return claim;
  }

  async function ingestClaim({ tenantState, claim }) {
    const body = {
      source: "live-demo",
      claims: [claim],
    };

    const response = await apiRequest({
      path: "/claims/ingest",
      method: "POST",
      tenantId: tenantState.tenantId,
      role: "scheme_user",
      userId: `sim-scheme-${tenantState.tenantId}`,
      body,
    });

    if (response.status >= 200 && response.status < 300 && response.json?.available) {
      stats.claimsGenerated += 1;
      pushActivity({
        tick: tickNumber,
        type: "claim_ingested",
        agent: "claim_submission_agent",
        tenantId: tenantState.tenantId,
        schemeId: claim.scheme_id,
        memberId: claim.member_id,
        providerId: claim.provider_id,
        claimId: claim.claim_id,
        scenario: claim._sim?.scenario?.key || null,
        story: claim._sim?.story?.key || null,
        decision: claim._sim?.scenario ? "fraud_pattern_injected" : "normal_healthcare_claim",
        correlationId: `${tenantState.tenantId}:${tickNumber}:${claim.claim_id}`,
      });

      if (claim._sim?.scenario) {
        tenantState.recentFraudCandidates.push({
          claim,
          scenario: claim._sim.scenario,
          createdAtTick: tickNumber,
          escalated: false,
        });
      }

      return true;
    }

    return false;
  }

  async function maybeCreateInvestigation(tenantState) {
    const activeCount = [...tenantState.activeInvestigations.values()].filter((entry) => entry.status !== "CLOSED").length;
    if (activeCount >= maxActiveInvestigations) {
      return false;
    }

    const candidates = tenantState.recentFraudCandidates.filter((candidate) => !candidate.escalated);
    if (candidates.length === 0 || !random.chance(0.45)) {
      return false;
    }

    const selected = random.pick(candidates);
    selected.escalated = true;

    const response = await apiRequest({
      path: "/investigations",
      method: "POST",
      tenantId: tenantState.tenantId,
      role: "fraud_analyst",
      userId: `sim-analyst-${tenantState.tenantId}`,
      body: {
        claimId: selected.claim.claim_id,
        assignedInvestigator: `sim-investigator-${tenantState.tenantId}`,
        priority: random.chance(0.2) ? "HIGH" : "NORMAL",
      },
    });

    if (response.status === 201 && response.json?.available && response.json.investigation?.investigationId) {
      const { investigation } = response.json;
      tenantState.activeInvestigations.set(investigation.investigationId, {
        investigationId: investigation.investigationId,
        claimId: selected.claim.claim_id,
        memberId: selected.claim.member_id,
        providerId: selected.claim.provider_id,
        status: "OPEN",
        scenario: selected.scenario,
        notes: 0,
        evidence: 0,
        published: false,
      });

      stats.investigationsCreated += 1;
      pushActivity({
        tick: tickNumber,
        type: "investigation_created",
        agent: "fraud_analyst_agent",
        tenantId: tenantState.tenantId,
        memberId: selected.claim.member_id,
        providerId: selected.claim.provider_id,
        investigationId: investigation.investigationId,
        claimId: selected.claim.claim_id,
        scenario: selected.scenario.key,
        decision: "escalate",
        correlationId: `${tenantState.tenantId}:${tickNumber}:${investigation.investigationId}`,
      });

      return true;
    }

    return false;
  }

  async function patchInvestigationStatus(tenantState, investigation, nextStatus) {
    if (!allowedTransition(investigation.status, nextStatus)) {
      return false;
    }

    const previousStatus = investigation.status;

    const response = await apiRequest({
      path: `/investigations/${encodeURIComponent(investigation.investigationId)}`,
      method: "PATCH",
      tenantId: tenantState.tenantId,
      role: "investigator",
      userId: `sim-investigator-${tenantState.tenantId}`,
      body: {
        status: nextStatus,
      },
    });

    if (response.status >= 200 && response.status < 300 && response.json?.available) {
      investigation.status = nextStatus;
      pushActivity({
        tick: tickNumber,
        type: "investigation_status",
        agent: "investigator_agent",
        tenantId: tenantState.tenantId,
        investigationId: investigation.investigationId,
        status: nextStatus,
        decision: `transition:${previousStatus}->${nextStatus}`,
        correlationId: `${tenantState.tenantId}:${tickNumber}:${investigation.investigationId}`,
      });
      return true;
    }

    return false;
  }

  async function addInvestigationNote(tenantState, investigation, text) {
    const response = await apiRequest({
      path: `/investigations/${encodeURIComponent(investigation.investigationId)}/notes`,
      method: "POST",
      tenantId: tenantState.tenantId,
      role: "investigator",
      userId: `sim-investigator-${tenantState.tenantId}`,
      body: {
        text,
        noteType: "INTERNAL_NOTE",
      },
    });

    if (response.status === 201 && response.json?.available) {
      investigation.notes += 1;
      return true;
    }

    return false;
  }

  async function addInvestigationEvidence(tenantState, investigation) {
    const response = await apiRequest({
      path: `/investigations/${encodeURIComponent(investigation.investigationId)}/evidence`,
      method: "POST",
      tenantId: tenantState.tenantId,
      role: "investigator",
      userId: `sim-investigator-${tenantState.tenantId}`,
      body: {
        filename: `sim-evidence-${investigation.investigationId}-${investigation.evidence + 1}.pdf`,
        description: `Synthetic evidence bundle ${investigation.evidence + 1}`,
        evidenceType: "DOCUMENT",
      },
    });

    if (response.status === 201 && response.json?.available) {
      investigation.evidence += 1;
      return true;
    }

    return false;
  }

  async function maybeConfirmFraud(tenantState, investigation, timelineNow) {
    const response = await apiRequest({
      path: "/investigations/confirm-fraud",
      method: "POST",
      tenantId: tenantState.tenantId,
      role: "investigator",
      userId: `sim-investigator-${tenantState.tenantId}`,
      body: {
        investigationId: investigation.investigationId,
        claimId: investigation.claimId,
        investigatorId: `sim-investigator-${tenantState.tenantId}`,
        reason: investigation.scenario.reason,
        schemeId: null,
        reportVersion: "live-demo",
        notes: `Scenario: ${investigation.scenario.key}`,
        registryMetadata: createRegistryMetadata({
          tenant: {
            name: tenantState.tenantName,
          },
          claim: {
            member_id: investigation.memberId,
            provider_id: investigation.providerId,
          },
          scenario: investigation.scenario,
          investigatorId: `sim-investigator-${tenantState.tenantId}`,
          timelineDate: toIsoDate(timelineNow),
        }),
      },
    });

    if (response.status === 201 && response.json?.available) {
      stats.fraudConfirmed += 1;
      stats.registryUpdates += response.json.registryEntry ? 1 : 0;
      investigation.published = Boolean(response.json.registryEntry);
      pushActivity({
        tick: tickNumber,
        type: "fraud_confirmed",
        agent: "investigator_agent",
        tenantId: tenantState.tenantId,
        investigationId: investigation.investigationId,
        decision: "confirm_fraud",
        correlationId: `${tenantState.tenantId}:${tickNumber}:${investigation.investigationId}`,
      });
      return true;
    }

    return false;
  }

  async function maybeReverseFraud(tenantState, investigation) {
    if (!investigation.published || !random.chance(0.08)) {
      return false;
    }

    const response = await apiRequest({
      path: "/investigations/reverse-fraud",
      method: "POST",
      tenantId: tenantState.tenantId,
      role: "investigator",
      userId: `sim-investigator-${tenantState.tenantId}`,
      body: {
        investigationId: investigation.investigationId,
        claimId: investigation.claimId,
        investigatorId: `sim-investigator-${tenantState.tenantId}`,
        reason: "Synthetic appeal accepted after committee review.",
      },
    });

    if (response.status === 201 && response.json?.available) {
      stats.fraudReversed += 1;
      stats.registryUpdates += response.json.registryEntry ? 1 : 0;
      pushActivity({
        tick: tickNumber,
        type: "fraud_reversed",
        agent: "applications_committee_agent",
        tenantId: tenantState.tenantId,
        investigationId: investigation.investigationId,
        decision: "reverse_fraud",
        correlationId: `${tenantState.tenantId}:${tickNumber}:${investigation.investigationId}`,
      });
      return true;
    }

    return false;
  }

  async function progressInvestigationForTenant(tenantState, timelineNow) {
    const active = [...tenantState.activeInvestigations.values()].filter((entry) => entry.status !== "CLOSED");
    if (active.length === 0) {
      return false;
    }

    const investigation = random.pick(active);
    if (!investigation) {
      return false;
    }

    if (investigation.status === "OPEN") {
      await patchInvestigationStatus(tenantState, investigation, "UNDER_REVIEW");
      return true;
    }

    if (investigation.status === "UNDER_REVIEW") {
      await addInvestigationNote(
        tenantState,
        investigation,
        `${investigation.scenario.reason} Evidence chain review in progress.`,
      );

      if (random.chance(0.6)) {
        await addInvestigationEvidence(tenantState, investigation);
      }

      if (random.chance(0.35)) {
        await patchInvestigationStatus(tenantState, investigation, "AWAITING_EVIDENCE");
        return true;
      }

      if (random.chance(0.4)) {
        await patchInvestigationStatus(tenantState, investigation, "CONFIRMED_FRAUD");
      } else if (random.chance(0.35)) {
        await patchInvestigationStatus(tenantState, investigation, "NO_FRAUD_FOUND");
      }
      return true;
    }

    if (investigation.status === "AWAITING_EVIDENCE") {
      await addInvestigationEvidence(tenantState, investigation);
      if (random.chance(0.7)) {
        await patchInvestigationStatus(tenantState, investigation, "UNDER_REVIEW");
      }
      return true;
    }

    if (investigation.status === "CONFIRMED_FRAUD") {
      if (!investigation.published) {
        await maybeConfirmFraud(tenantState, investigation, timelineNow);
      }

      return true;
    }

    if (investigation.status === "NO_FRAUD_FOUND") {
      if (random.chance(0.6)) {
        const closed = await patchInvestigationStatus(tenantState, investigation, "CLOSED");
        if (closed) {
          stats.investigationsClosed += 1;
        }
      }

      return true;
    }

    return false;
  }

  async function maybeReviewClosedOutcomes(tenantState) {
    const closedEligible = [...tenantState.activeInvestigations.values()].filter(
      (entry) => entry.status === "CONFIRMED_FRAUD" || entry.status === "NO_FRAUD_FOUND",
    );

    if (closedEligible.length === 0) {
      return null;
    }

    const selected = random.pick(closedEligible);
    if (!selected) {
      return null;
    }

    if (selected.status === "CONFIRMED_FRAUD" && selected.published && random.chance(0.08)) {
      await maybeReverseFraud(tenantState, selected);
    }

    if (random.chance(0.45)) {
      const closed = await patchInvestigationStatus(tenantState, selected, "CLOSED");
      if (closed) {
        stats.investigationsClosed += 1;
        return "committee_closed_case";
      }
    }

    return "committee_reviewed_case";
  }

  function updateProviderRelationships(tenantState, updates = null) {
    const updateCount = Number.isFinite(updates) ? updates : random.int(0, 2);
    tenantState.providerRelationshipVersion += updateCount;
    tenantState.relationshipUpdates += updateCount;
    stats.relationshipUpdates += updateCount;

    if (updateCount > 0) {
      pushActivity({
        tick: tickNumber,
        type: "provider_relationship_update",
        agent: "provider_behaviour_agent",
        tenantId: tenantState.tenantId,
        count: updateCount,
        decision: "network_update",
        correlationId: `${tenantState.tenantId}:${tickNumber}:provider-network`,
      });
    }
  }

  async function simulateTick() {
    if (!enabled) {
      return {
        tick: tickNumber,
        claims: 0,
        investigations: 0,
        confirmations: 0,
        reversals: 0,
      };
    }

    tickNumber += 1;
    stats.ticks += 1;

    const now = timeline.advance(random);
    const tickPlan = {
      ...scheduler.nextTickPlan({ tickNumber }),
      tickNumber,
    };

    if (agentRuntime.claimSubmission) {
      await agentRuntime.claimSubmission.runTick({ tickPlan, timelineNow: now });
    }

    if (agentRuntime.fraudAnalyst) {
      await agentRuntime.fraudAnalyst.runTick({ tickPlan, timelineNow: now });
    }

    if (agentRuntime.investigator) {
      await agentRuntime.investigator.runTick({ tickPlan, timelineNow: now });
    }

    if (agentRuntime.committee) {
      await agentRuntime.committee.runTick({ tickPlan, timelineNow: now });
    }

    const tenantForRelationshipUpdate = pickTenantState();
    if (tenantForRelationshipUpdate) {
      const planned = tenantForRelationshipUpdate.agents.provider.planRelationshipUpdates();
      updateProviderRelationships(tenantForRelationshipUpdate, planned);
    }

    for (const tenantState of tenantStates.values()) {
      while (tenantState.recentFraudCandidates.length > maxRecentClaims) {
        tenantState.recentFraudCandidates.shift();
      }
    }

    return {
      tick: tickNumber,
      claims: stats.claimsGenerated,
      investigations: stats.investigationsCreated,
      confirmations: stats.fraudConfirmed,
      reversals: stats.fraudReversed,
    };
  }

  async function initialize() {
    if (!enabled) {
      return;
    }

    if (!bootstrap || typeof bootstrap.loadCatalog !== "function") {
      throw new Error("Live demo simulator requires bootstrap.loadCatalog for tenant/member/provider catalog.");
    }

    const catalog = await bootstrap.loadCatalog();
    tenantStates = new Map();
    for (const tenant of catalog || []) {
      if (!tenant?.tenant_id || !Array.isArray(tenant.members) || !Array.isArray(tenant.providers)) {
        continue;
      }

      if (tenant.members.length === 0 || tenant.providers.length === 0) {
        continue;
      }

      const tenantState = createTenantState(tenant, random);
      tenantState.agents.member = createMemberBehaviourAgent({ random });
      tenantState.agents.provider = createProviderBehaviourAgent({ random });
      tenantStates.set(tenant.tenant_id, tenantState);
    }

    log("info", "live_demo_catalog_loaded", {
      tenants: tenantStates.size,
      members: [...tenantStates.values()].reduce((sum, tenant) => sum + tenant.members.length, 0),
      providers: [...tenantStates.values()].reduce((sum, tenant) => sum + tenant.providers.length, 0),
      tickIntervalMs,
      seed,
      mode,
      staticMode,
      stories: storyEngine.activeStories,
    });

    agentRuntime.claimSubmission = createClaimSubmissionAgent({
      random,
      storyEngine,
      fraudRate,
      scenarios: FRAUD_SCENARIOS,
      pickTenantState,
      buildClaimForTenant,
      ingestClaim,
      pushActivity,
    });

    agentRuntime.fraudAnalyst = createFraudAnalystAgent({
      random,
      pickTenantState,
      maybeCreateInvestigation,
      pushActivity,
    });

    agentRuntime.investigator = createInvestigatorAgent({
      pickTenantState,
      progressInvestigationForTenant,
      pushActivity,
    });

    agentRuntime.committee = createApplicationsCommitteeAgent({
      random,
      pickTenantState,
      maybeReviewClosedOutcomes,
      pushActivity,
    });
  }

  async function start() {
    if (running || !enabled) {
      return;
    }

    await initialize();
    running = true;

    timer = setInterval(async () => {
      try {
        await simulateTick();
      } catch (error) {
        log("error", "live_demo_tick_failed", {
          message: error?.message || String(error),
          tick: tickNumber,
        });
      }
    }, tickIntervalMs);

    log("info", "live_demo_started", {
      tickIntervalMs,
      seed,
      enabled,
      mode,
      staticMode,
      stories: storyEngine.activeStories,
    });
  }

  function stop() {
    if (!running) {
      return;
    }

    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    log("info", "live_demo_stopped", {
      ticks: stats.ticks,
      claimsGenerated: stats.claimsGenerated,
      investigationsCreated: stats.investigationsCreated,
      fraudConfirmed: stats.fraudConfirmed,
      fraudReversed: stats.fraudReversed,
      registryUpdates: stats.registryUpdates,
    });
  }

  function getSnapshot() {
    return {
      enabled,
      mode,
      staticMode,
      running,
      tickNumber,
      now: timeline.current().toISOString(),
      stats: {
        ...stats,
      },
      tenants: [...tenantStates.values()].map((tenant) => ({
        tenantId: tenant.tenantId,
        tenantName: tenant.tenantName,
        schemes: [...tenant.schemes],
        members: tenant.members.length,
        providers: tenant.providers.length,
        activeInvestigations: [...tenant.activeInvestigations.values()].filter((entry) => entry.status !== "CLOSED").length,
        relationshipUpdates: tenant.relationshipUpdates,
      })),
      activityTail: activityLog.slice(-100),
      stories: storyEngine.activeStories,
    };
  }

  return {
    start,
    stop,
    runTick: simulateTick,
    getSnapshot,
  };
}

export function createLiveDemoBootstrapFromDatabase({
  pool,
  configuredTenantIds = [],
  seed = 42,
  logger,
} = {}) {
  const random = new SeededRandom(seed);

  function log(level, event, details = {}) {
    if (typeof logger === "function") {
      logger(level, event, details);
    }
  }

  async function queryRows(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows || [];
  }

  async function resolveTenantRows() {
    if (configuredTenantIds.length > 0) {
      const placeholders = inListQueryPlaceholders(configuredTenantIds);
      return queryRows(
        `
          SELECT tenant_id, tenant_name
          FROM tenants
          WHERE status = 'active'
            AND tenant_id IN (${placeholders})
          ORDER BY tenant_id ASC
        `,
        configuredTenantIds,
      );
    }

    return queryRows(
      `
        SELECT tenant_id, tenant_name
        FROM tenants
        WHERE status = 'active'
          AND tenant_id <> 'tenant_default'
        ORDER BY tenant_id ASC
      `,
    );
  }

  async function resolveSchemeRows(tenantId) {
    const medicalSchemeRows = await queryRows(
      `
        SELECT scheme_id
        FROM medical_schemes
        WHERE tenant_id = ?
        ORDER BY scheme_id ASC
      `,
      [tenantId],
    );

    if (medicalSchemeRows.length > 0) {
      return medicalSchemeRows.map((row) => row.scheme_id);
    }

    const legacySchemeRows = await queryRows(
      `
        SELECT scheme_id
        FROM schemes
        WHERE tenant_id = ?
        ORDER BY scheme_id ASC
      `,
      [tenantId],
    );

    return legacySchemeRows.map((row) => row.scheme_id);
  }

  async function maybeInsertBootstrapMembers({ tenantId, schemeId, targetCount }) {
    const rows = [];
    for (let index = 0; index < targetCount; index += 1) {
      const gender = random.chance(0.5) ? "M" : "F";
      const birthYear = random.int(1945, 2019);
      const birthMonth = String(random.int(1, 12)).padStart(2, "0");
      const birthDay = String(random.int(1, 28)).padStart(2, "0");
      const region = pickProvince(random);
      const memberId = `SIMM-${tenantId.replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase()}-${schemeId}-${String(index + 1).padStart(5, "0")}`;

      rows.push([
        memberId,
        schemeId,
        `Member${String(index + 1).padStart(5, "0")}`,
        `Sim${tenantId.slice(-4)}`,
        `${birthYear}-${birthMonth}-${birthDay}`,
        gender,
        `SIMID-${hashToNumber(`${memberId}:id`)}`,
        `SIMBANK-M-${hashToNumber(`${memberId}:bank`)}`,
        region,
        Number((-35 + random.next() * 6).toFixed(5)),
        Number((18 + random.next() * 15).toFixed(5)),
        "2025-01-01",
        tenantId,
      ]);
    }

    if (rows.length === 0) {
      return;
    }

    const placeholders = rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = rows.flat();
    await pool.query(
      `
        INSERT IGNORE INTO members (
          member_id,
          scheme_id,
          first_name,
          last_name,
          date_of_birth,
          gender,
          synthetic_id_number,
          synthetic_banking_detail,
          home_region,
          home_lat,
          home_lon,
          join_date,
          tenant_id
        ) VALUES ${placeholders}
      `,
      values,
    );
  }

  async function maybeInsertBootstrapProviders({ tenantId, schemeId, targetCount }) {
    const rows = [];
    for (let index = 0; index < targetCount; index += 1) {
      const providerId = `SIMP-${tenantId.replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase()}-${schemeId}-${String(index + 1).padStart(4, "0")}`;
      const specialty = random.pick(PROVIDER_SPECIALTIES);
      const region = pickProvince(random);
      rows.push([
        providerId,
        schemeId,
        `PRAC-${hashToNumber(`${providerId}:prac`)}`,
        specialty,
        `${specialty.replace(/_/g, " ")} ${String(index + 1).padStart(3, "0")}`,
        `SIMBANK-P-${hashToNumber(`${providerId}:bank`)}`,
        region,
        Number((-35 + random.next() * 6).toFixed(5)),
        Number((18 + random.next() * 15).toFixed(5)),
        tenantId,
      ]);
    }

    if (rows.length === 0) {
      return;
    }

    const placeholders = rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const values = rows.flat();
    await pool.query(
      `
        INSERT IGNORE INTO providers (
          provider_id,
          scheme_id,
          practice_number,
          specialty,
          practice_name,
          synthetic_banking_detail,
          practice_region,
          practice_lat,
          practice_lon,
          tenant_id
        ) VALUES ${placeholders}
      `,
      values,
    );
  }

  async function ensureBootstrapCapacity({ tenantId, schemeIds }) {
    for (const schemeId of schemeIds) {
      const [memberCountRow] = await queryRows(
        "SELECT COUNT(*) AS total FROM members WHERE tenant_id = ? AND scheme_id = ?",
        [tenantId, schemeId],
      );
      const [providerCountRow] = await queryRows(
        "SELECT COUNT(*) AS total FROM providers WHERE tenant_id = ? AND scheme_id = ?",
        [tenantId, schemeId],
      );

      const memberCount = Number(memberCountRow?.total || 0);
      const providerCount = Number(providerCountRow?.total || 0);

      if (memberCount < 120) {
        await maybeInsertBootstrapMembers({
          tenantId,
          schemeId,
          targetCount: 120 - memberCount,
        });
      }

      if (providerCount < 30) {
        await maybeInsertBootstrapProviders({
          tenantId,
          schemeId,
          targetCount: 30 - providerCount,
        });
      }
    }
  }

  async function loadCatalog() {
    const tenantRows = await resolveTenantRows();
    const catalog = [];

    for (const tenant of tenantRows) {
      const schemeIds = await resolveSchemeRows(tenant.tenant_id);
      if (schemeIds.length === 0) {
        continue;
      }

      await ensureBootstrapCapacity({
        tenantId: tenant.tenant_id,
        schemeIds,
      });

      const placeholders = inListQueryPlaceholders(schemeIds);
      const members = await queryRows(
        `
          SELECT member_id, scheme_id, home_region
          FROM members
          WHERE tenant_id = ?
            AND scheme_id IN (${placeholders})
          ORDER BY member_id ASC
          LIMIT 2500
        `,
        [tenant.tenant_id, ...schemeIds],
      );

      const providers = await queryRows(
        `
          SELECT provider_id, scheme_id, specialty, synthetic_banking_detail
          FROM providers
          WHERE tenant_id = ?
            AND scheme_id IN (${placeholders})
          ORDER BY provider_id ASC
          LIMIT 1200
        `,
        [tenant.tenant_id, ...schemeIds],
      );

      if (members.length === 0 || providers.length === 0) {
        continue;
      }

      catalog.push({
        tenant_id: tenant.tenant_id,
        tenant_name: tenant.tenant_name,
        schemes: schemeIds,
        members,
        providers,
      });
    }

    log("info", "live_demo_bootstrap_completed", {
      tenants: catalog.length,
      configuredTenantIds,
    });

    return catalog;
  }

  return {
    loadCatalog,
  };
}
