const JOURNEY_TEMPLATES = {
  acute: ["consultation", "pharmacy", "consultation"],
  chronic: ["consultation", "pharmacy", "pharmacy", "consultation", "referral"],
  hospital: ["consultation", "hospital", "pathology", "referral", "consultation"],
  maternity: ["consultation", "referral", "hospital", "consultation", "pharmacy"],
};

function pickJourneyTemplate(memberProfile, random) {
  if (memberProfile?.chronic) {
    return "chronic";
  }
  if (memberProfile?.utilization === "high_utilization") {
    return "hospital";
  }
  if (memberProfile?.behavior === "identity_misuse") {
    return random.chance(0.6) ? "hospital" : "acute";
  }
  if (memberProfile?.dependants >= 2 && random.chance(0.25)) {
    return "maternity";
  }
  return "acute";
}

function weightedMemberPick(members, random) {
  const weighted = [];

  for (const member of members) {
    const profile = member.profile || {};
    let weight = 1;

    if (profile.chronic) {
      weight += 2;
    }
    if (profile.utilization === "high_utilization") {
      weight += 2;
    }
    if (profile.utilization === "frequent_claimant") {
      weight += 1;
    }
    if (profile.behavior === "doctor_shopper") {
      weight += 1;
    }

    weighted.push({ member, weight });
  }

  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) {
    return members[random.int(0, members.length - 1)] || null;
  }

  let threshold = random.next() * total;
  for (const item of weighted) {
    threshold -= item.weight;
    if (threshold <= 0) {
      return item.member;
    }
  }

  return weighted[weighted.length - 1]?.member || null;
}

export function createMemberBehaviourAgent({ random } = {}) {
  const journeys = new Map();

  function nextJourneyStep(member) {
    const memberId = member.member_id;
    const existing = journeys.get(memberId);

    if (!existing) {
      const templateKey = pickJourneyTemplate(member.profile || {}, random);
      const created = {
        templateKey,
        stepIndex: 0,
      };
      journeys.set(memberId, created);
      return created;
    }

    existing.stepIndex = (existing.stepIndex + 1) % JOURNEY_TEMPLATES[existing.templateKey].length;
    return existing;
  }

  function selectMemberIntent(tenantState) {
    if (!tenantState?.members?.length) {
      return null;
    }

    const member = weightedMemberPick(tenantState.members, random);
    if (!member) {
      return null;
    }

    const journey = nextJourneyStep(member);
    const claimFamilyHint = JOURNEY_TEMPLATES[journey.templateKey][journey.stepIndex] || "consultation";

    return {
      member,
      claimFamilyHint,
      journeyKey: journey.templateKey,
      journeyStep: journey.stepIndex,
      behavior: member.profile?.behavior || "normal",
      utilization: member.profile?.utilization || "normal",
      chronic: Boolean(member.profile?.chronic),
      dependants: Number(member.profile?.dependants || 0),
    };
  }

  return {
    name: "member_behaviour_agent",
    selectMemberIntent,
  };
}
