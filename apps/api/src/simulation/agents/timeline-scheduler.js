export function createTimelineScheduler({ random, staticMode = false, maxClaimsPerTick = 3 } = {}) {
  function nextTickPlan() {
    const boundedClaims = Math.max(0, Math.min(3, Number.parseInt(maxClaimsPerTick, 10) || 0));
    const claimsToCreate = random.int(0, boundedClaims);

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
