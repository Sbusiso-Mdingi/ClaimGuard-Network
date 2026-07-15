const FAMILY_SPECIALTY_HINTS = {
  consultation: ["GENERAL_PRACTITIONER", "SPECIALIST"],
  pathology: ["PATHOLOGIST", "RADIOLOGIST"],
  pharmacy: ["PHARMACY"],
  hospital: ["HOSPITAL"],
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
    const hinted = providersForScheme.filter((entry) => matchesHint(entry, memberIntent.claimFamilyHint));
    const candidatePool = hinted.length > 0 ? hinted : providersForScheme;

    if (candidatePool.length === 0) {
      return null;
    }

    const provider = candidatePool[random.int(0, candidatePool.length - 1)];

    return {
      provider,
      riskProfile: provider.profile?.riskProfile || "honest",
      collusionLikelihood: Number(provider.profile?.networkAffinity || 0),
    };
  }

  function planRelationshipUpdates() {
    return random.int(0, 2);
  }

  return {
    name: "provider_behaviour_agent",
    selectProviderIntent,
    planRelationshipUpdates,
  };
}
