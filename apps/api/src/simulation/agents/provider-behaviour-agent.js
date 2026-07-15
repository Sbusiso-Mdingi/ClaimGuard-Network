const FAMILY_SPECIALTY_HINTS = {
  consultation: ["GENERAL_PRACTITIONER", "SPECIALIST"],
  pathology: ["PATHOLOGIST", "RADIOLOGIST"],
  radiology: ["RADIOLOGIST"],
  pharmacy: ["PHARMACY"],
  hospital: ["HOSPITAL"],
  obstetric: ["OBSTETRICIAN", "SPECIALIST"],
  paediatric: ["PAEDIATRICIAN", "SPECIALIST"],
  referral: ["SPECIALIST", "GENERAL_PRACTITIONER"],
};

function matchesHint(provider, claimFamilyHint) {
  const hints = FAMILY_SPECIALTY_HINTS[claimFamilyHint] || [];
  if (hints.length === 0) {
    return true;
  }

  const specialty = String(provider.specialty || "").toUpperCase();
  return hints.some((hint) => specialty.includes(hint));
}

export function createProviderBehaviourAgent({ random } = {}) {
  function selectProviderIntent(tenantState, memberIntent) {
    if (!tenantState?.providers?.length || !memberIntent?.member) {
      return null;
    }

    const schemeId = memberIntent.member.scheme_id;
    const providersForScheme = tenantState.providers.filter((entry) => entry.scheme_id === schemeId);
    const preferredSpecialties = Array.isArray(memberIntent?.preferredSpecialties)
      ? memberIntent.preferredSpecialties
      : [];

    const preferredMatches = providersForScheme.filter((entry) => {
      const specialty = String(entry.specialty || "").toUpperCase();
      return preferredSpecialties.some((hint) => specialty.includes(String(hint).toUpperCase()));
    });

    const hinted = providersForScheme.filter((entry) => matchesHint(entry, memberIntent.claimFamilyHint));
    const candidatePool = preferredMatches.length > 0 ? preferredMatches : hinted.length > 0 ? hinted : providersForScheme;

    if (candidatePool.length === 0) {
      return null;
    }

    const provider = candidatePool[random.int(0, candidatePool.length - 1)];

    return {
      provider,
      riskProfile: provider.profile?.riskProfile || "honest",
      utilizationProfile: provider.profile?.utilizationProfile || "balanced",
      referralBehavior: provider.profile?.referralBehavior || "gatekeeper",
      networkRelationships: provider.profile?.networkRelationships || "neutral",
      collusionLikelihood: Number(provider.profile?.networkAffinity || 0),
    };
  }

  function planRelationshipUpdates(tenantState) {
    const providers = tenantState?.providers || [];
    const suspicious = providers.filter((entry) =>
      ["suspicious", "fraudulent"].includes(entry.profile?.riskProfile),
    ).length;
    const specialistDensity = Number(tenantState?.persona?.specialistDensity || 1);
    const base = random.int(0, 1);
    const suspiciousBoost = suspicious > 0 && random.chance(Math.min(0.5, suspicious / Math.max(1, providers.length))) ? 1 : 0;
    const specialistBoost = specialistDensity > 1.15 && random.chance(0.35) ? 1 : 0;
    return Math.min(3, base + suspiciousBoost + specialistBoost);
  }

  return {
    name: "provider_behaviour_agent",
    selectProviderIntent,
    planRelationshipUpdates,
  };
}
