function chooseFraudScenario({ random, fraudRate, scenarios, storyPick, memberIntent, providerIntent }) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    return null;
  }

  if (storyPick?.scenarioKey) {
    return scenarios.find((entry) => entry.key === storyPick.scenarioKey) || null;
  }

  let adjustedFraudRate = fraudRate;
  const candidateKeys = new Set();

  candidateKeys.add("duplicate_billing");
  candidateKeys.add("procedure_inflation");

  if (memberIntent?.behavior === "identity_misuse" || memberIntent?.behavior === "doctor_shopper") {
    adjustedFraudRate += 0.02;
    candidateKeys.add("identity_reuse");
    candidateKeys.add("doctor_shopping");
    if (memberIntent?.behavior === "identity_misuse") {
      candidateKeys.add("ghost_patient");
    }
  }

  if (memberIntent?.claimFamilyHint === "pathology" || memberIntent?.claimFamilyHint === "radiology") {
    candidateKeys.add("excessive_pathology");
  }

  if (providerIntent?.riskProfile === "fraudulent") {
    adjustedFraudRate += 0.03;
    candidateKeys.add("provider_collusion");
    candidateKeys.add("network_collusion");
    candidateKeys.add("repeat_offender");
    candidateKeys.add("recovered_provider");
  } else if (providerIntent?.riskProfile === "suspicious") {
    adjustedFraudRate += 0.015;
    candidateKeys.add("impossible_travel");
    candidateKeys.add("duplicate_billing");
  }

  if (providerIntent?.networkRelationships === "ring_member" || providerIntent?.networkRelationships === "referral_cartel") {
    adjustedFraudRate += 0.01;
    candidateKeys.add("network_collusion");
    candidateKeys.add("cross_scheme_fraud");
  }

  adjustedFraudRate = Math.max(0.02, Math.min(0.05, adjustedFraudRate));

  if (!random.chance(adjustedFraudRate)) {
    return null;
  }

  const candidates = scenarios.filter((entry) => candidateKeys.has(entry.key));
  const pool = candidates.length > 0 ? candidates : scenarios;
  return pool[random.int(0, pool.length - 1)] || null;
}

export function createClaimSubmissionAgent({
  random,
  storyEngine,
  fraudRate,
  scenarios,
  pickTenantState,
  buildClaimForTenant,
  ingestClaim,
  pushActivity,
} = {}) {
  async function runTick({ tickPlan, timelineNow }) {
    let created = 0;

    for (let index = 0; index < tickPlan.claimsToCreate; index += 1) {
      const tenantState = pickTenantState();
      if (!tenantState) {
        break;
      }

      const memberIntent = tenantState.agents.member.selectMemberIntent(tenantState);
      const providerIntent = tenantState.agents.provider.selectProviderIntent(tenantState, memberIntent);
      if (!memberIntent || !providerIntent) {
        continue;
      }

      const storyPick = storyEngine.pickScenarioKey(random, scenarios);
      const scenario = chooseFraudScenario({
        random,
        fraudRate,
        scenarios,
        storyPick,
        memberIntent,
        providerIntent,
      });

      const claim = buildClaimForTenant(tenantState, timelineNow, {
        member: memberIntent.member,
        provider: providerIntent.provider,
        claimFamilyHint: memberIntent.claimFamilyHint,
        scenario,
        story: storyPick?.story || null,
        memberIntent,
        providerIntent,
      });

      if (!claim) {
        continue;
      }

      const result = await ingestClaim({ tenantState, claim });
      if (result) {
        created += 1;
      }

      pushActivity({
        tick: tickPlan.tickNumber,
        type: "agent_decision",
        agent: "claim_submission_agent",
        tenantId: tenantState.tenantId,
        schemeId: claim.scheme_id,
        memberId: claim.member_id,
        providerId: claim.provider_id,
        claimId: claim.claim_id,
        story: claim._sim?.story?.key || null,
        decision: scenario ? `fraud_pattern:${scenario.key}` : "normal_claim",
        correlationId: `${tenantState.tenantId}:${tickPlan.tickNumber}:${claim.claim_id}`,
      });
    }

    return created;
  }

  return {
    name: "claim_submission_agent",
    runTick,
  };
}
