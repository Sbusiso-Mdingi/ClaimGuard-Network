export function createTimelineScheduler({ random, staticMode = false, maxClaimsPerTick = 3, minClaimsPerTick = 0 } = {}) {
  function nextTickPlan() {
    const boundedClaims = Math.max(0, Math.min(3, Number.parseInt(maxClaimsPerTick, 10) || 0));
    const minimumClaims = Math.max(0, Math.min(boundedClaims, Number.parseInt(minClaimsPerTick, 10) || 0));
    const claimsToCreate = random.int(minimumClaims, boundedClaims);

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
