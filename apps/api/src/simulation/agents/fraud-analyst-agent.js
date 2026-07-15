export function createFraudAnalystAgent({ random, pickTenantState, maybeCreateInvestigation, pushActivity } = {}) {
  async function runTick({ tickPlan }) {
    if (!tickPlan.shouldCreateInvestigation) {
      return 0;
    }

    const tenantState = pickTenantState();
    if (!tenantState) {
      return 0;
    }

    const created = await maybeCreateInvestigation(tenantState);
    if (created) {
      pushActivity({
        tick: tickPlan.tickNumber,
        type: "agent_decision",
        agent: "fraud_analyst_agent",
        tenantId: tenantState.tenantId,
        decision: "escalate_claim_to_investigation",
        correlationId: `${tenantState.tenantId}:${tickPlan.tickNumber}:fraud-analyst`,
      });
      return 1;
    }

    return 0;
  }

  return {
    name: "fraud_analyst_agent",
    runTick,
  };
}
