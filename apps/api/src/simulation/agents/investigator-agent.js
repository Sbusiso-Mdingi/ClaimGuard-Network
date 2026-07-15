export function createInvestigatorAgent({ pickTenantState, progressInvestigationForTenant, pushActivity } = {}) {
  async function runTick({ tickPlan, timelineNow }) {
    if (!tickPlan.shouldUpdateInvestigation) {
      return 0;
    }

    const tenantState = pickTenantState();
    if (!tenantState) {
      return 0;
    }

    const progressed = await progressInvestigationForTenant(tenantState, timelineNow);
    if (progressed) {
      pushActivity({
        tick: tickPlan.tickNumber,
        type: "agent_decision",
        agent: "investigator_agent",
        tenantId: tenantState.tenantId,
        decision: "investigation_progressed",
        correlationId: `${tenantState.tenantId}:${tickPlan.tickNumber}:investigator`,
      });
      return 1;
    }

    return 0;
  }

  return {
    name: "investigator_agent",
    runTick,
  };
}
