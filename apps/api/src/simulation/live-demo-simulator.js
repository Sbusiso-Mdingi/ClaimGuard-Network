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
export const SIMULATOR_CHECKPOINT_VERSION = 1;

const PROVIDER_SPECIALTIES = [
  "GENERAL_PRACTITIONER",
  "HOSPITAL",
  "DENTIST",
  "PHYSIOTHERAPIST",
  "PATHOLOGIST",
  "RADIOLOGIST",
  "PHARMACY",
  "OBSTETRICIAN",
  "PAEDIATRICIAN",
  "SPECIALIST",
];

const BILLING_CODES = {
  consultation: ["CONSULT_GP", "CONSULT_SPECIALIST", "CHECKUP", "VACCINATION"],
  pathology: ["PATH_LIPID", "PATH_HBA1C", "PATH_CBC", "PATH_THYROID"],
  radiology: ["RAD_XRAY", "RAD_CT", "RAD_MRI", "RAD_ULTRASOUND"],
  pharmacy: ["RX_CHRONIC", "RX_ACUTE", "RX_ANTIBIOTIC", "RX_CONTROLLED"],
  hospital: ["HOSP_ADMISSION", "ER_VISIT", "WARD_DAY", "SURGERY_MINOR"],
  obstetric: ["OBS_ANTENATAL", "OBS_DELIVERY", "OBS_FOLLOWUP"],
  paediatric: ["PAED_NEWBORN", "PAED_CONSULT", "PAED_IMMUNISATION"],
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
  { key: "cross_scheme_fraud", offenceCategory: "Cross-Scheme Fraud", reason: "Cross-scheme subject correlation pattern detected from registry intelligence feed." },
  { key: "recovered_provider", offenceCategory: "Recovered Fraud Provider", reason: "Recovered fraudulent provider resumed suspicious billing patterns." },
  { key: "repeat_offender", offenceCategory: "Repeat Offender", reason: "Repeat offender behavior observed across prior case history." },
];

const MEMBER_UTILIZATION_PROFILES = ["normal", "frequent_claimant", "chronic", "doctor_shopper", "high_utilization"];
const MEMBER_BEHAVIORS = ["normal", "frequent_claimant", "doctor_shopper", "identity_misuse", "collusive"];
const PROVIDER_RISK_PROFILES = ["honest", "aggressive", "suspicious", "fraudulent"];
const MEMBER_ARCHETYPES = [
  "healthy_young_adult",
  "family_with_dependants",
  "chronic_diabetic",
  "hypertensive_retiree",
  "pregnant_member",
  "high_utilisation_member",
  "doctor_shopping_member",
];

function chooseWeighted(choices, randomValue) {
  const total = choices.reduce((sum, entry) => sum + Number(entry.weight || 0), 0);
  if (total <= 0) {
    return choices[0]?.value || null;
  }

  let threshold = randomValue * total;
  for (const entry of choices) {
    threshold -= Number(entry.weight || 0);
    if (threshold <= 0) {
      return entry.value;
    }
  }

  return choices[choices.length - 1]?.value || null;
}

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
      segment: "discovery",
      demographics: "large_population",
      chronicBurden: "medium",
      claimVolumeWeight: 1.4,
      specialistDensity: 1.3,
      memberTarget: 240,
      providerTarget: 75,
    };
  }

  if (normalized.includes("bonitas")) {
    return {
      segment: "bonitas",
      demographics: "older_population",
      chronicBurden: "high",
      claimVolumeWeight: 1.2,
      specialistDensity: 1.1,
      memberTarget: 180,
      providerTarget: 55,
    };
  }

  if (normalized.includes("momentum")) {
    return {
      segment: "momentum",
      demographics: "younger_population",
      chronicBurden: "low",
      claimVolumeWeight: 0.9,
      specialistDensity: 1.0,
      memberTarget: 140,
      providerTarget: 40,
    };
  }

  if (normalized.includes("medihelp")) {
    return {
      segment: "medihelp",
      demographics: "mixed_population",
      chronicBurden: "medium",
      claimVolumeWeight: 1.0,
      specialistDensity: 1.05,
      memberTarget: 155,
      providerTarget: 45,
    };
  }

  if (normalized.includes("fedhealth")) {
    return {
      segment: "fedhealth",
      demographics: "younger_population",
      chronicBurden: "low",
      claimVolumeWeight: 0.78,
      specialistDensity: 0.9,
      memberTarget: 120,
      providerTarget: 34,
    };
  }

  return {
    segment: "default",
    demographics: "mixed_population",
    chronicBurden: random.pick(["low", "medium", "high"]),
    claimVolumeWeight: Number((0.9 + random.next() * 0.5).toFixed(2)),
    specialistDensity: Number((0.9 + random.next() * 0.5).toFixed(2)),
    memberTarget: 120,
    providerTarget: 30,
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
    return "radiology";
  }
  if (normalized.includes("OBSTETRIC")) {
    return "obstetric";
  }
  if (normalized.includes("PAEDIATRIC")) {
    return "paediatric";
  }
  if (normalized.includes("HOSP")) {
    return "hospital";
  }
  if (normalized.includes("SPECIAL")) {
    return "referral";
  }
  return "consultation";
}

function createHeaders({ tenantId, userId, role, authorityMode = "demo_headers" }) {
  if (authorityMode === "session") {
    return {
      "x-cg-service-actor": userId,
      "x-cg-service-role": role,
      "x-cg-service-tenant": tenantId,
    };
  }
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

function buildMemberProfile(memberId, tenantPersona = null) {
  const hashed = hashToNumber(memberId);
  const age = 18 + (hashed % 67);
  const ageBand = age < 30 ? "young_adult" : age < 45 ? "adult" : age < 60 ? "midlife" : "retiree";
  const personaSegment = tenantPersona?.segment || "default";
  const roll = (hashed % 10_000) / 10_000;

  const archetypeWeights =
    personaSegment === "discovery"
      ? [
          { value: "healthy_young_adult", weight: 18 },
          { value: "family_with_dependants", weight: 24 },
          { value: "chronic_diabetic", weight: 13 },
          { value: "hypertensive_retiree", weight: 11 },
          { value: "pregnant_member", weight: 9 },
          { value: "high_utilisation_member", weight: 17 },
          { value: "doctor_shopping_member", weight: 8 },
        ]
      : personaSegment === "bonitas"
        ? [
            { value: "healthy_young_adult", weight: 8 },
            { value: "family_with_dependants", weight: 14 },
            { value: "chronic_diabetic", weight: 24 },
            { value: "hypertensive_retiree", weight: 26 },
            { value: "pregnant_member", weight: 5 },
            { value: "high_utilisation_member", weight: 16 },
            { value: "doctor_shopping_member", weight: 7 },
          ]
        : personaSegment === "momentum"
          ? [
              { value: "healthy_young_adult", weight: 33 },
              { value: "family_with_dependants", weight: 28 },
              { value: "chronic_diabetic", weight: 7 },
              { value: "hypertensive_retiree", weight: 5 },
              { value: "pregnant_member", weight: 13 },
              { value: "high_utilisation_member", weight: 8 },
              { value: "doctor_shopping_member", weight: 6 },
            ]
          : personaSegment === "fedhealth"
            ? [
                { value: "healthy_young_adult", weight: 32 },
                { value: "family_with_dependants", weight: 29 },
                { value: "chronic_diabetic", weight: 8 },
                { value: "hypertensive_retiree", weight: 7 },
                { value: "pregnant_member", weight: 11 },
                { value: "high_utilisation_member", weight: 7 },
                { value: "doctor_shopping_member", weight: 6 },
              ]
            : personaSegment === "medihelp"
              ? [
                  { value: "healthy_young_adult", weight: 17 },
                  { value: "family_with_dependants", weight: 25 },
                  { value: "chronic_diabetic", weight: 15 },
                  { value: "hypertensive_retiree", weight: 15 },
                  { value: "pregnant_member", weight: 8 },
                  { value: "high_utilisation_member", weight: 13 },
                  { value: "doctor_shopping_member", weight: 7 },
                ]
              : MEMBER_ARCHETYPES.map((value) => ({ value, weight: 1 }));

  const archetype = chooseWeighted(archetypeWeights, roll) || MEMBER_ARCHETYPES[hashed % MEMBER_ARCHETYPES.length];
  const chronic = archetype === "chronic_diabetic" || archetype === "hypertensive_retiree" || Boolean((hashed >> 6) % 2);
  const utilization =
    archetype === "high_utilisation_member"
      ? "high_utilization"
      : archetype === "chronic_diabetic" || archetype === "hypertensive_retiree"
        ? "chronic"
        : archetype === "doctor_shopping_member"
          ? "doctor_shopper"
          : MEMBER_UTILIZATION_PROFILES[hashed % MEMBER_UTILIZATION_PROFILES.length];
  const behavior =
    archetype === "doctor_shopping_member"
      ? "doctor_shopper"
      : archetype === "high_utilisation_member"
        ? "frequent_claimant"
        : archetype === "pregnant_member"
          ? "normal"
          : MEMBER_BEHAVIORS[(hashed >> 3) % MEMBER_BEHAVIORS.length];

  return {
    archetype,
    ageBand,
    age,
    utilization,
    behavior,
    chronic,
    dependants: (hashed >> 7) % 4,
    chronicConditions:
      archetype === "chronic_diabetic"
        ? ["diabetes"]
        : archetype === "hypertensive_retiree"
          ? ["hypertension"]
          : chronic
            ? ["chronic_condition"]
            : [],
    pregnancyEligible: archetype === "pregnant_member",
  };
}

function buildProviderProfile(providerId, specialty = "") {
  const hashed = hashToNumber(providerId);
  const normalizedSpecialty = String(specialty || "").toUpperCase();
  const utilizationProfile =
    normalizedSpecialty.includes("HOSP")
      ? "high_throughput"
      : normalizedSpecialty.includes("PHARM")
        ? "repeat_dispensing"
        : normalizedSpecialty.includes("RADIO") || normalizedSpecialty.includes("PATH")
          ? "diagnostic_batch"
          : normalizedSpecialty.includes("SPECIAL") || normalizedSpecialty.includes("OBSTETRIC") || normalizedSpecialty.includes("PAEDIATRIC")
            ? "specialist_referral"
            : "balanced";

  const referralBehavior =
    normalizedSpecialty.includes("GENERAL_PRACTITIONER")
      ? "gatekeeper"
      : normalizedSpecialty.includes("SPECIAL") || normalizedSpecialty.includes("OBSTETRIC") || normalizedSpecialty.includes("PAEDIATRIC")
        ? "referral_hub"
        : normalizedSpecialty.includes("PATH") || normalizedSpecialty.includes("RADIO")
          ? "diagnostic_support"
          : normalizedSpecialty.includes("PHARM")
            ? "dispensing"
            : "facility";

  const networkRelationships =
    (hashed >> 9) % 20 === 0
      ? "ring_member"
      : (hashed >> 10) % 15 === 0
        ? "referral_cartel"
        : "neutral";

  return {
    riskProfile: PROVIDER_RISK_PROFILES[hashed % PROVIDER_RISK_PROFILES.length],
    utilizationProfile,
    referralBehavior,
    networkRelationships,
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
  const persona = deriveTenantPersona(tenant.tenant_name, random);
  const members = tenant.members.map((member) => ({
    ...member,
    profile: buildMemberProfile(member.member_id, persona),
  }));

  const providers = tenant.providers.map((provider) => ({
    ...provider,
    profile: buildProviderProfile(provider.provider_id, provider.specialty),
  }));

  return {
    tenantId: tenant.tenant_id,
    tenantName: tenant.tenant_name,
    persona,
    schemes: [...tenant.schemes],
    members,
    providers,
    activeInvestigations: new Map(),
    recentFraudCandidates: [],
    providerRelationshipVersion: 0,
    relationshipUpdates: 0,
    lastSeenMemberIds: new Set(),
    lastSeenProviderIds: new Set(),
    memberClaimHistory: new Map(),
    providerClaimHistory: new Map(),
    sharedIdentityTokens: new Map(),
    sharedProviderRingToken: `ring:${tenant.tenant_id}`,
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
  initialCheckpoint = null,
  maxClaimsPerTick = 3,
  authorityMode = "demo_headers",
} = {}) {
  const random = new SeededRandom(seed);
  const timeline = defaultTimeline(timelineConfig);
  const storyEngine = createStoryEngine({ storyMode });
  const scheduler = createTimelineScheduler({ random, staticMode, maxClaimsPerTick });

  let running = false;
  let initialized = false;
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
  const storyProgress = {
    selectedStories: [...storyEngine.activeStories],
    currentStep: 0,
    completedSteps: [],
    nextEligibleSimulatedTime: timeline.current().toISOString(),
  };

  function validateCheckpoint(checkpoint) {
    if (!checkpoint) return;
    if (typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
      throw new Error("Simulator checkpoint must be an object.");
    }
    if (checkpoint.version !== SIMULATOR_CHECKPOINT_VERSION) {
      throw new Error(`Unsupported simulator checkpoint version ${checkpoint.version}.`);
    }
    if (!Number.isInteger(checkpoint.tickNumber) || checkpoint.tickNumber < 0) {
      throw new Error("Simulator checkpoint tickNumber is invalid.");
    }
  }

  validateCheckpoint(initialCheckpoint);

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
      headers: createHeaders({ tenantId, role, userId, authorityMode }),
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

  function registerClaimHistory(tenantState, claim) {
    const memberHistory = tenantState.memberClaimHistory.get(claim.member_id) || [];
    memberHistory.push({
      claimId: claim.claim_id,
      serviceDate: claim.service_date,
      providerId: claim.provider_id,
      billingCode: claim.billing_code,
      amount: claim.amount,
      scenarioKey: claim._sim?.scenario?.key || null,
    });
    while (memberHistory.length > 24) {
      memberHistory.shift();
    }
    tenantState.memberClaimHistory.set(claim.member_id, memberHistory);

    const providerHistory = tenantState.providerClaimHistory.get(claim.provider_id) || [];
    providerHistory.push({
      claimId: claim.claim_id,
      serviceDate: claim.service_date,
      memberId: claim.member_id,
      billingCode: claim.billing_code,
      amount: claim.amount,
      scenarioKey: claim._sim?.scenario?.key || null,
    });
    while (providerHistory.length > 32) {
      providerHistory.shift();
    }
    tenantState.providerClaimHistory.set(claim.provider_id, providerHistory);
  }

  function applyFraudScenarioArtifacts({ tenantState, claim, scenario, member, provider }) {
    const evidenceSignals = [];

    if (!scenario) {
      return evidenceSignals;
    }

    const memberHistory = tenantState.memberClaimHistory.get(member.member_id) || [];
    const providerHistory = tenantState.providerClaimHistory.get(provider.provider_id) || [];

    if (scenario.key === "duplicate_billing" && memberHistory.length > 0) {
      const last = memberHistory[memberHistory.length - 1];
      claim.service_date = last.serviceDate;
      claim.billing_code = last.billingCode;
      claim.amount = last.amount;
      evidenceSignals.push("same_day_duplicate_claim_signature");
    }

    if (scenario.key === "ghost_patient") {
      claim.device_id = `shared-device-${member.scheme_id}`;
      claim.phone = `+272100000${String(hashToNumber(member.scheme_id) % 10)}`;
      evidenceSignals.push("reused_device_and_contact_pattern");
    }

    if (scenario.key === "identity_reuse") {
      const token = tenantState.sharedIdentityTokens.get(member.scheme_id) || `identity-token-${member.scheme_id}`;
      tenantState.sharedIdentityTokens.set(member.scheme_id, token);
      claim.email = `${token}@demo.claimguard.local`;
      claim.phone = `+2782000${String(hashToNumber(token) % 10000).padStart(4, "0")}`;
      evidenceSignals.push("shared_identity_artifact");
    }

    if (scenario.key === "procedure_inflation") {
      claim.amount = Number((claim.amount * random.int(2, 4)).toFixed(2));
      evidenceSignals.push("procedure_cost_outlier");
    }

    if (scenario.key === "excessive_pathology") {
      claim.billing_code = random.pick(BILLING_CODES.pathology);
      evidenceSignals.push("pathology_frequency_spike");
    }

    if (scenario.key === "doctor_shopping") {
      evidenceSignals.push("multi_provider_consultation_cluster");
    }

    if (scenario.key === "provider_collusion" || scenario.key === "network_collusion") {
      claim.bank_account = `COLLUSION-${tenantState.sharedProviderRingToken}`;
      evidenceSignals.push("shared_provider_banking_pattern");
    }

    if (scenario.key === "impossible_travel") {
      claim.ip_address = `196.${random.int(1, 250)}.${random.int(1, 250)}.${random.int(1, 250)}`;
      evidenceSignals.push("geo_temporal_inconsistency");
    }

    if (scenario.key === "cross_scheme_fraud") {
      evidenceSignals.push("cross_scheme_subject_recurrence");
    }

    if (scenario.key === "repeat_offender") {
      evidenceSignals.push("historical_offender_link");
    }

    if (scenario.key === "recovered_provider") {
      evidenceSignals.push("provider_recidivism_signal");
    }

    return evidenceSignals;
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
    const amount = amountBase;

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
        carePathway: options.memberIntent?.carePathway || null,
        member,
        provider,
      },
    };

    const evidenceSignals = applyFraudScenarioArtifacts({
      tenantState,
      claim,
      scenario,
      member,
      provider,
    });

    if (scenario) {
      claim._sim.evidenceSignals = evidenceSignals.length > 0 ? evidenceSignals : [`scenario_evidence:${scenario.key}`];
    }

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
          evidenceSignals: claim._sim.evidenceSignals || [],
          createdAtTick: tickNumber,
          escalated: false,
        });
      }

      registerClaimHistory(tenantState, claim);

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
        evidenceSignals: selected.evidenceSignals || [],
        notes: 0,
        evidence: 0,
        published: false,
        createdAtTick: tickNumber,
        nextReviewTick: tickNumber + random.int(1, 3),
        reviewCycles: 0,
        targetEvidenceCount: random.int(1, 4),
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
        reason: investigation.scenario.reason,
        idempotencyKey: `sim-confirm:${investigation.investigationId}`,
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
        reason: "Synthetic appeal accepted after committee review.",
        idempotencyKey: `sim-reverse:${investigation.investigationId}`,
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

    if (tickNumber < (investigation.nextReviewTick || 0)) {
      return false;
    }

    investigation.reviewCycles = Number(investigation.reviewCycles || 0) + 1;
    investigation.nextReviewTick = tickNumber + random.int(1, 3);

    if (investigation.status === "OPEN") {
      if (random.chance(0.65)) {
        await patchInvestigationStatus(tenantState, investigation, "UNDER_REVIEW");
      }
      return true;
    }

    if (investigation.status === "UNDER_REVIEW") {
      const evidenceHeadline = investigation.evidenceSignals?.[investigation.notes % Math.max(1, investigation.evidenceSignals.length)] || investigation.scenario.reason;
      await addInvestigationNote(
        tenantState,
        investigation,
        `${evidenceHeadline} Evidence chain review in progress. Cycle ${investigation.reviewCycles}.`,
      );

      if (investigation.evidence < investigation.targetEvidenceCount && random.chance(0.7)) {
        await addInvestigationEvidence(tenantState, investigation);
      }

      if (investigation.evidence < investigation.targetEvidenceCount && random.chance(0.4)) {
        await patchInvestigationStatus(tenantState, investigation, "AWAITING_EVIDENCE");
        return true;
      }

      if (investigation.evidence >= investigation.targetEvidenceCount && random.chance(0.35)) {
        await patchInvestigationStatus(tenantState, investigation, "CONFIRMED_FRAUD");
      } else if (investigation.reviewCycles >= 2 && random.chance(0.25)) {
        await patchInvestigationStatus(tenantState, investigation, "NO_FRAUD_FOUND");
      }

      return true;
    }

    if (investigation.status === "AWAITING_EVIDENCE") {
      await addInvestigationEvidence(tenantState, investigation);
      if (random.chance(0.55)) {
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
      if (random.chance(0.25)) {
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

    if (random.chance(0.3)) {
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
      const planned = tenantForRelationshipUpdate.agents.provider.planRelationshipUpdates(tenantForRelationshipUpdate);
      updateProviderRelationships(tenantForRelationshipUpdate, planned);
    }

    for (const tenantState of tenantStates.values()) {
      while (tenantState.recentFraudCandidates.length > maxRecentClaims) {
        tenantState.recentFraudCandidates.shift();
      }
    }

    storyProgress.currentStep = tickNumber;
    storyProgress.completedSteps.push(tickNumber);
    storyProgress.completedSteps = storyProgress.completedSteps.slice(-100);
    storyProgress.nextEligibleSimulatedTime = timeline.current().toISOString();

    return {
      tick: tickNumber,
      claims: stats.claimsGenerated,
      investigations: stats.investigationsCreated,
      confirmations: stats.fraudConfirmed,
      reversals: stats.fraudReversed,
    };
  }

  async function initialize() {
    if (!enabled || initialized) {
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

    if (initialCheckpoint) {
      tickNumber = Number(initialCheckpoint.tickNumber);
      claimSequence = Number(initialCheckpoint.claimSequence || 0);
      random.state = Number(initialCheckpoint.randomState || seed) >>> 0;
      timeline.now = new Date(initialCheckpoint.simulatedTime || timeline.current());
      Object.assign(stats, initialCheckpoint.stats || {});
      Object.assign(storyProgress, initialCheckpoint.storyProgress || {});

      for (const persistedTenant of initialCheckpoint.tenants || []) {
        const tenantState = tenantStates.get(persistedTenant.tenantId);
        if (!tenantState) continue;
        tenantState.providerRelationshipVersion = Number(persistedTenant.providerRelationshipVersion || 0);
        tenantState.relationshipUpdates = Number(persistedTenant.relationshipUpdates || 0);
        tenantState.randomWeight = Number(persistedTenant.randomWeight || tenantState.randomWeight);
        tenantState.lastSeenMemberIds = new Set(persistedTenant.lastSeenMemberIds || []);
        tenantState.lastSeenProviderIds = new Set(persistedTenant.lastSeenProviderIds || []);
        tenantState.sharedIdentityTokens = new Map(persistedTenant.sharedIdentityTokens || []);
        tenantState.activeInvestigations = new Map(
          (persistedTenant.activeInvestigations || []).map((entry) => [
            entry.investigationId,
            {
              ...entry,
              scenario: FRAUD_SCENARIOS.find((scenario) => scenario.key === entry.scenarioKey) || null,
            },
          ]),
        );
        tenantState.recentFraudCandidates = (persistedTenant.recentFraudCandidates || []).map((entry) => ({
          claim: {
            claim_id: entry.claimId,
            member_id: entry.memberId,
            provider_id: entry.providerId,
          },
          scenario: FRAUD_SCENARIOS.find((scenario) => scenario.key === entry.scenarioKey) || null,
          evidenceSignals: entry.evidenceSignals || [],
          createdAtTick: Number(entry.createdAtTick || 0),
          escalated: Boolean(entry.escalated),
        })).filter((entry) => entry.scenario);
      }
    }

    initialized = true;

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

  function getCheckpoint() {
    if (!initialized) {
      throw new Error("Simulator must be initialized before checkpoint export.");
    }
    return {
      version: SIMULATOR_CHECKPOINT_VERSION,
      configurationVersion: 1,
      mode,
      seed,
      randomState: random.state,
      tickNumber,
      claimSequence,
      simulatedTime: timeline.current().toISOString(),
      stats: { ...stats },
      storyProgress: {
        selectedStories: [...storyProgress.selectedStories],
        currentStep: storyProgress.currentStep,
        completedSteps: [...storyProgress.completedSteps],
        nextEligibleSimulatedTime: storyProgress.nextEligibleSimulatedTime,
      },
      tenants: [...tenantStates.values()].map((tenant) => ({
        tenantId: tenant.tenantId,
        providerRelationshipVersion: tenant.providerRelationshipVersion,
        relationshipUpdates: tenant.relationshipUpdates,
        randomWeight: tenant.randomWeight,
        lastSeenMemberIds: [...tenant.lastSeenMemberIds],
        lastSeenProviderIds: [...tenant.lastSeenProviderIds],
        sharedIdentityTokens: [...tenant.sharedIdentityTokens.entries()],
        recentFraudCandidates: tenant.recentFraudCandidates.map((candidate) => ({
          claimId: candidate.claim.claim_id,
          memberId: candidate.claim.member_id,
          providerId: candidate.claim.provider_id,
          scenarioKey: candidate.scenario?.key || null,
          evidenceSignals: candidate.evidenceSignals || [],
          createdAtTick: candidate.createdAtTick,
          escalated: Boolean(candidate.escalated),
        })),
        activeInvestigations: [...tenant.activeInvestigations.values()].map((investigation) => ({
          investigationId: investigation.investigationId,
          claimId: investigation.claimId,
          memberId: investigation.memberId,
          providerId: investigation.providerId,
          status: investigation.status,
          scenarioKey: investigation.scenario?.key || null,
          evidenceSignals: investigation.evidenceSignals || [],
          notes: investigation.notes,
          evidence: investigation.evidence,
          published: Boolean(investigation.published),
          createdAtTick: investigation.createdAtTick,
          nextReviewTick: investigation.nextReviewTick,
          reviewCycles: investigation.reviewCycles,
          targetEvidenceCount: investigation.targetEvidenceCount,
        })),
      })),
      lastCompletedCorrelationId: `${mode}:${tickNumber}`,
    };
  }

  return {
    start,
    stop,
    runTick: simulateTick,
    getSnapshot,
    getCheckpoint,
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

  async function maybeInsertBootstrapMembers({ tenantId, tenantName, schemeId, targetCount }) {
    const persona = deriveTenantPersona(tenantName, random);
    const rows = [];
    for (let index = 0; index < targetCount; index += 1) {
      const gender = random.chance(0.5) ? "M" : "F";
      const birthYear =
        persona.segment === "bonitas"
          ? random.int(1942, 1985)
          : persona.segment === "momentum" || persona.segment === "fedhealth"
            ? random.int(1975, 2010)
            : random.int(1952, 2008);
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

  async function maybeInsertBootstrapProviders({ tenantId, tenantName, schemeId, targetCount }) {
    const persona = deriveTenantPersona(tenantName, random);
    const specialtyWeights =
      persona.segment === "discovery"
        ? [
            { value: "GENERAL_PRACTITIONER", weight: 20 },
            { value: "SPECIALIST", weight: 18 },
            { value: "HOSPITAL", weight: 12 },
            { value: "RADIOLOGIST", weight: 10 },
            { value: "PATHOLOGIST", weight: 10 },
            { value: "PHARMACY", weight: 12 },
            { value: "PHYSIOTHERAPIST", weight: 8 },
            { value: "DENTIST", weight: 6 },
            { value: "OBSTETRICIAN", weight: 2 },
            { value: "PAEDIATRICIAN", weight: 2 },
          ]
        : persona.segment === "bonitas"
          ? [
              { value: "GENERAL_PRACTITIONER", weight: 22 },
              { value: "SPECIALIST", weight: 16 },
              { value: "HOSPITAL", weight: 12 },
              { value: "RADIOLOGIST", weight: 8 },
              { value: "PATHOLOGIST", weight: 12 },
              { value: "PHARMACY", weight: 14 },
              { value: "PHYSIOTHERAPIST", weight: 5 },
              { value: "DENTIST", weight: 5 },
              { value: "OBSTETRICIAN", weight: 3 },
              { value: "PAEDIATRICIAN", weight: 3 },
            ]
          : persona.segment === "momentum"
            ? [
                { value: "GENERAL_PRACTITIONER", weight: 24 },
                { value: "SPECIALIST", weight: 11 },
                { value: "HOSPITAL", weight: 9 },
                { value: "RADIOLOGIST", weight: 7 },
                { value: "PATHOLOGIST", weight: 7 },
                { value: "PHARMACY", weight: 18 },
                { value: "PHYSIOTHERAPIST", weight: 10 },
                { value: "DENTIST", weight: 10 },
                { value: "OBSTETRICIAN", weight: 2 },
                { value: "PAEDIATRICIAN", weight: 2 },
              ]
            : PROVIDER_SPECIALTIES.map((value) => ({ value, weight: 1 }));

    const rows = [];
    for (let index = 0; index < targetCount; index += 1) {
      const providerId = `SIMP-${tenantId.replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase()}-${schemeId}-${String(index + 1).padStart(4, "0")}`;
      const specialty = chooseWeighted(specialtyWeights, random.next()) || random.pick(PROVIDER_SPECIALTIES);
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

  async function ensureBootstrapCapacity({ tenantId, tenantName, schemeIds }) {
    const persona = deriveTenantPersona(tenantName, random);
    const targetMembers = Number(persona.memberTarget || 120);
    const targetProviders = Number(persona.providerTarget || 30);

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

      if (memberCount < targetMembers) {
        await maybeInsertBootstrapMembers({
          tenantId,
          tenantName,
          schemeId,
          targetCount: targetMembers - memberCount,
        });
      }

      if (providerCount < targetProviders) {
        await maybeInsertBootstrapProviders({
          tenantId,
          schemeId,
          tenantName,
          targetCount: targetProviders - providerCount,
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
        tenantName: tenant.tenant_name,
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
