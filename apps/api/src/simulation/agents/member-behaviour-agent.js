const CARE_PATHWAYS = {
  healthy_young_adult: [
    { claimFamily: "consultation", specialties: ["GENERAL_PRACTITIONER"] },
    { claimFamily: "pharmacy", specialties: ["PHARMACY"] },
  ],
  family_with_dependants: [
    { claimFamily: "consultation", specialties: ["GENERAL_PRACTITIONER"] },
    { claimFamily: "referral", specialties: ["SPECIALIST"] },
    { claimFamily: "pharmacy", specialties: ["PHARMACY"] },
  ],
  chronic_diabetic: [
    { claimFamily: "consultation", specialties: ["GENERAL_PRACTITIONER"] },
    { claimFamily: "pharmacy", specialties: ["PHARMACY"] },
    { claimFamily: "pharmacy", specialties: ["PHARMACY"] },
    { claimFamily: "referral", specialties: ["SPECIALIST"] },
  ],
  hypertensive_retiree: [
    { claimFamily: "consultation", specialties: ["GENERAL_PRACTITIONER"] },
    { claimFamily: "pathology", specialties: ["PATHOLOGIST"] },
    { claimFamily: "pharmacy", specialties: ["PHARMACY"] },
    { claimFamily: "referral", specialties: ["SPECIALIST"] },
  ],
  pregnant_member: [
    { claimFamily: "consultation", specialties: ["GENERAL_PRACTITIONER"] },
    { claimFamily: "obstetric", specialties: ["OBSTETRICIAN"] },
    { claimFamily: "hospital", specialties: ["HOSPITAL"] },
    { claimFamily: "paediatric", specialties: ["PAEDIATRICIAN"] },
  ],
  high_utilisation_member: [
    { claimFamily: "consultation", specialties: ["GENERAL_PRACTITIONER"] },
    { claimFamily: "hospital", specialties: ["HOSPITAL"] },
    { claimFamily: "radiology", specialties: ["RADIOLOGIST"] },
    { claimFamily: "pathology", specialties: ["PATHOLOGIST"] },
    { claimFamily: "referral", specialties: ["SPECIALIST"] },
  ],
  doctor_shopping_member: [
    { claimFamily: "consultation", specialties: ["GENERAL_PRACTITIONER", "SPECIALIST"] },
    { claimFamily: "consultation", specialties: ["GENERAL_PRACTITIONER", "SPECIALIST"] },
    { claimFamily: "pharmacy", specialties: ["PHARMACY"] },
    { claimFamily: "consultation", specialties: ["GENERAL_PRACTITIONER", "SPECIALIST"] },
  ],
};

function pickJourneyTemplate(memberProfile, random) {
  if (memberProfile?.archetype && CARE_PATHWAYS[memberProfile.archetype]) {
    return memberProfile.archetype;
  }

  if (memberProfile?.chronic) {
    return "chronic_diabetic";
  }

  if (memberProfile?.utilization === "high_utilization") {
    return "high_utilisation_member";
  }

  if (memberProfile?.behavior === "doctor_shopper") {
    return "doctor_shopping_member";
  }

  if (memberProfile?.dependants >= 2 && random.chance(0.35)) {
    return "family_with_dependants";
  }

  return "healthy_young_adult";
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

    existing.stepIndex = (existing.stepIndex + 1) % CARE_PATHWAYS[existing.templateKey].length;
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
    const currentStep = CARE_PATHWAYS[journey.templateKey][journey.stepIndex] || CARE_PATHWAYS.healthy_young_adult[0];

    return {
      member,
      claimFamilyHint: currentStep.claimFamily,
      preferredSpecialties: currentStep.specialties,
      carePathway: journey.templateKey,
      journeyKey: journey.templateKey,
      journeyStep: journey.stepIndex,
      behavior: member.profile?.behavior || "normal",
      utilization: member.profile?.utilization || "normal",
      chronic: Boolean(member.profile?.chronic),
      dependants: Number(member.profile?.dependants || 0),
      archetype: member.profile?.archetype || journey.templateKey,
    };
  }

  return {
    name: "member_behaviour_agent",
    selectMemberIntent,
  };
}
