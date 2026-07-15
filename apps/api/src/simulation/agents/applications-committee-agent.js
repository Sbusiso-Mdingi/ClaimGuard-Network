export function createApplicationsCommitteeAgent({ random, pickTenantState, maybeReviewClosedOutcomes, pushActivity } = {}) {
  async function runTick({ tickPlan }) {
    if (!tickPlan.shouldRunCommittee) {
      return 0;
    }

    const tenantState = pickTenantState();
    if (!tenantState) {
      return 0;
    }

    const action = await maybeReviewClosedOutcomes(tenantState, random);
    if (action) {
      pushActivity({
        tick: tickPlan.tickNumber,
        type: "agent_decision",
        agent: "applications_committee_agent",
        tenantId: tenantState.tenantId,
        decision: action,
        correlationId: `${tenantState.tenantId}:${tickPlan.tickNumber}:committee`,
      });
      return 1;
    }

    return 0;
  }

  return {
    name: "applications_committee_agent",
    runTick,
  };
}
