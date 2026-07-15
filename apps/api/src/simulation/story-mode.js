const STORY_SCENARIOS = {
  provider_collusion: {
    key: "provider_collusion",
    label: "Provider Collusion",
    scenarioKeys: ["provider_collusion", "network_collusion", "duplicate_billing"],
  },
  duplicate_mri_billing: {
    key: "duplicate_mri_billing",
    label: "Duplicate MRI Billing",
    scenarioKeys: ["duplicate_billing", "procedure_inflation", "impossible_travel"],
  },
  identity_theft: {
    key: "identity_theft",
    label: "Identity Theft",
    scenarioKeys: ["identity_reuse", "ghost_patient", "doctor_shopping"],
  },
  cross_scheme_fraud_ring: {
    key: "cross_scheme_fraud_ring",
    label: "Cross-Scheme Fraud Ring",
    scenarioKeys: ["network_collusion", "repeat_offender", "provider_collusion"],
  },
};

function normalizeStoryToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeStoryList(storyMode) {
  if (!storyMode) {
    return [];
  }

  return String(storyMode)
    .split(",")
    .map(normalizeStoryToken)
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .filter((value) => Boolean(STORY_SCENARIOS[value]));
}

export function createStoryEngine({ storyMode = "" } = {}) {
  const activeStoryKeys = normalizeStoryList(storyMode);

  function pickStory(random) {
    if (activeStoryKeys.length === 0) {
      return null;
    }

    const key = activeStoryKeys[random.int(0, activeStoryKeys.length - 1)];
    return STORY_SCENARIOS[key] || null;
  }

  function pickScenarioKey(random, fallbackScenarios) {
    const story = pickStory(random);
    if (!story) {
      return null;
    }

    const allowed = story.scenarioKeys.filter((scenarioKey) =>
      fallbackScenarios.some((entry) => entry.key === scenarioKey),
    );

    if (allowed.length === 0) {
      return null;
    }

    return {
      story,
      scenarioKey: allowed[random.int(0, allowed.length - 1)],
    };
  }

  return {
    activeStories: activeStoryKeys.map((key) => STORY_SCENARIOS[key].label),
    hasStories() {
      return activeStoryKeys.length > 0;
    },
    pickScenarioKey,
  };
}
