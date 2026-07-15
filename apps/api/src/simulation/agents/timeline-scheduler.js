export function createTimelineScheduler({ random, staticMode = false } = {}) {
  function nextTickPlan() {
    const claimsToCreate = random.int(0, 3);

    return {
      claimsToCreate,
      shouldCreateInvestigation: random.chance(0.7),
      shouldUpdateInvestigation: random.chance(0.8),
      shouldRunCommittee: random.chance(staticMode ? 0.4 : 0.5),
      providerRelationshipUpdates: random.int(0, 2),
    };
  }

  return {
    nextTickPlan,
  };
}
