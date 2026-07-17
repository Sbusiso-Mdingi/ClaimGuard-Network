# ClaimGuard Production-Readiness Qualification Plan

ClaimGuard is not production-ready yet. This plan defines the future gates that must be passed before anyone may make that claim.

## Readiness Scorecard

Statuses:

- Not assessed
- Planned
- In progress
- Evidence collected
- Approved
- Blocked

## Required Gates

| # | Gate | Status | Evidence required | Approval authority |
| --- | --- | --- | --- | --- |
| 1 | Architecture and threat-model approval | Not assessed | signed review | architecture owner |
| 2 | Privacy/POPIA review | Not assessed | written assessment | privacy/legal owner |
| 3 | Independent penetration test | Not assessed | external report | security owner |
| 4 | Remediation and retest | Not assessed | fix verification | security owner |
| 5 | Backup restore exercise | Not assessed | successful restore evidence | operations owner |
| 6 | Disaster-recovery exercise | Not assessed | DR drill evidence | operations owner |
| 7 | Load, soak, and capacity tests | Not assessed | measured results | platform owner |
| 8 | SLO definition and measured evidence | Not assessed | SLO baseline and trend data | service owner |
| 9 | Incident-response exercise | Not assessed | tabletop and technical drill | operations owner |
| 10 | Access/RBAC review | Not assessed | least-privilege review record | security/platform owner |
| 11 | Secret-rotation exercise | Not assessed | rotation and rollback record | platform owner |
| 12 | Dependency and vulnerability review | Not assessed | scan evidence and remediation plan | engineering owner |
| 13 | Data-retention and deletion exercise | Not assessed | retention/deletion test results | privacy/legal owner |
| 14 | Monitoring and alert-response validation | Not assessed | alert firing and response evidence | operations owner |
| 15 | Support and on-call ownership | Not assessed | named ownership matrix | service owner |
| 16 | Legal / contractual approval | Not assessed | approved sign-off | legal / governance owner |
| 17 | Production launch review and signed risk acceptance | Not assessed | launch approval record | executive owner |

## Explicit Non-Claims

- No repository test alone can declare production readiness.
- No agent output alone can declare production readiness.
- No single cloud configuration check alone can declare production readiness.

## Phase 12 Deliverable

Phase 12 is complete only when the technical production-shaped foundation exists and this qualification plan is published alongside it. The later gates remain future work.

## Current Delta From Phase 12A

- Evidence collected: API database and control-plane database settings now use Key Vault references in live app settings.
- Evidence collected: temporary elevated operator vault write access used for migration was removed.
- Evidence collected: API post-migration health and readiness returned to HTTP 200 after controlled restart.
- Blocked: authentication smoke for target users still returns `AUTHENTICATION_FAILED` (HTTP 401) on proxy login path.
- Blocked: CI deployment run for workflow change commit `47fd1f7` failed in migration step (`Run database migrations`, run `29609437005`).
- Not approved: no production-readiness gate is considered approved by this Phase 12A execution.
