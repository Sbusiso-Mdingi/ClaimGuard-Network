# ClaimGuard Risk Register

## High-Priority Risks

| Risk | Impact | Likelihood | Current state | Mitigation | Evidence needed |
| --- | --- | --- | --- | --- | --- |
| Live secrets in App Service settings | secret exposure | medium | present | migrate to governed secret boundary and Key Vault references | validated cutover and rollback |
| Public network exposure on API/web/MySQL/Key Vault | unauthorized access | medium | present | staged network hardening with rollback path | verified private or restricted path |
| No formal production-readiness evidence | overstatement of readiness | high | present | separate production-shaped from production-ready | qualification plan and gate evidence |
| Incomplete Doppler inventory | ambiguous source of truth | medium | present | enumerate configs, tokens, and services | documented project/config ownership |
| Heap exhaustion / large transform risk | outage or slowdowns | medium | known | bounded pages, memory telemetry, scaling thresholds | load test and memory profiling |
| Access review not yet completed | privilege creep | medium | present | review Azure RBAC, GitHub protections, workflow permissions | access-review record |
| Backup restore not yet exercised | restore failure under incident | medium | present | non-destructive restore exercise | restore evidence |
| DR not yet exercised | prolonged outage | medium | present | staged DR drill | DR evidence |
| Scenario Lab separation not yet implemented | accidental mixing of synthetic and live flows | low-medium | future | keep out of Phase 12 scope | architecture approval |

## Residual Risks

- The repository still has legacy/demo rollback paths for authentication.
- Live Azure posture still exposes public endpoints and public access to some data-plane services.
- Doppler access could not be fully enumerated from this environment.
