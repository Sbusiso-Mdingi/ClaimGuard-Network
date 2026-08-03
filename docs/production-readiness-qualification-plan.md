# ClaimGuard Production-Readiness Qualification Plan

ClaimGuard is production-shaped, not production-ready. No live medical-scheme use or cross-scheme production sharing may begin until the applicable gates below have approved evidence.

## Status Values

- Not assessed
- Planned
- In progress
- Evidence collected
- Approved
- Blocked

## Required Gates

| # | Gate | Status | Evidence required | Approval authority |
|---|---|---|---|---|
| 1 | Architecture and threat-model approval | Not assessed | Signed review of trust boundaries, tenant routing, environment separation, and failure modes | Architecture owner |
| 2 | Product-purpose approval | Not assessed | Confirmed prohibition of automatic payment, recovery, sanction, guilt, or contracting decisions | Scheme governance/product owner |
| 3 | Investigation workflow approval | Not assessed | Complete signal, triage, notice, response, evidence, report, decision, reasons, review, appeal, correction, withdrawal, and expiry workflow | Scheme FWA/legal owner |
| 4 | Human-decision separation | Not assessed | Tests and role matrix proving that a model or investigator report cannot directly activate an adverse outcome or network notice | Governance/security owner |
| 5 | Privacy/POPIA impact assessment | Not assessed | Approved data-flow inventory, lawful basis, minimality, retention, correction, cross-border, and residual-risk assessment | Information Officer/privacy counsel |
| 6 | Legal-role and contracting approval | Not assessed | Responsible-party/operator/sub-operator matrix, operator agreements, data-sharing agreements, and scheme-rule review | Legal/privacy owner |
| 7 | Prior-authorisation analysis | Not assessed | Written assessment for unique-identifier linkage, suspected unlawful conduct, and cross-scheme processing | Information Officer/privacy counsel |
| 8 | Privacy-preserving linkage approval | Not assessed | Independent cryptographic design and threat-model review; no universal re-identification key | Independent privacy/cryptography reviewer |
| 9 | Network-notice governance | Not assessed | Bounded notice schema, sharing authority, appeal status, expiry, withdrawal, and correction propagation | Scheme governance/legal owner |
| 10 | Environment-separation approval | Not assessed | Separate production databases, queues, identities, secrets, storage, telemetry, credentials, backups, and endpoints | Platform/security owner |
| 11 | Clean production cutover | Not assessed | Empty production stores, migration evidence, approved seed manifest, and proof that no staging transactional rows were copied | Data/platform owner |
| 12 | Production-canary qualification | Not assessed | Isolated synthetic-only route and successful authentication, ingestion, outbox, scoring, report, audit, and isolation checks | Operations owner |
| 13 | Access/RBAC review | Not assessed | Least-privilege review for Azure, GitHub, CI/CD, support, tenant, and investigation roles | Security owner |
| 14 | Secret-rotation exercise | Not assessed | Rotation, revocation, and rollback evidence for application and ingestion credentials | Platform owner |
| 15 | Independent penetration test | Not assessed | External report covering application, cloud, tenant, API, and worker boundaries | Security owner |
| 16 | Remediation and retest | Not assessed | Verification that critical and high findings are closed | Security owner |
| 17 | Supply-chain qualification | Not assessed | Dependency, container, IaC, secret, SAST/DAST, SBOM, and image-signing evidence | Engineering/security owner |
| 18 | Backup restore exercise | Not assessed | Successful isolated restore and validation evidence | Operations owner |
| 19 | Disaster-recovery exercise | Not assessed | DR drill and authoritative-data decision evidence | Operations owner |
| 20 | Rollback qualification | Not assessed | Previous-compatible application rollback without reconnecting to staging or replacing production data | Platform/data owner |
| 21 | Load, soak, and capacity tests | Not assessed | Measured API, worker, queue, database, graph, and storage results | Platform owner |
| 22 | SLO definition and measured evidence | Not assessed | SLO baseline, error budget, and trend data | Service owner |
| 23 | Incident-response exercise | Not assessed | Tabletop and technical exercise including cross-tenant, breach, credential, and queue incidents | Operations/Information Officer |
| 24 | Breach-notification workflow | Not assessed | Operator-to-scheme escalation, regulator/data-subject decision records, templates, and evidence preservation | Information Officer/legal owner |
| 25 | Data-retention and deletion exercise | Not assessed | Tested correction/deletion propagation across live data, reports, notices, logs, queues, and backups | Privacy/legal owner |
| 26 | Model validation and reproducibility | Not assessed | Baseline, calibration, feature lineage, versioning, replay, drift, explainability, and override evidence | Independent model validator |
| 27 | Fairness and provider-burden review | Not assessed | Discipline-specific outcome analysis, proxy review, false-positive burden, and mitigation record | Independent statistician/governance owner |
| 28 | Monitoring and alert-response validation | Not assessed | Alert firing, routing, escalation, redaction, and response evidence | Operations owner |
| 29 | Support and on-call ownership | Not assessed | Named responsibilities, escalation paths, response targets, and access controls | Service owner |
| 30 | Silent single-scheme pilot | Not assessed | Historical and prospective silent-mode results with no payment or provider effect | Scheme board/delegated risk committee |
| 31 | Pilot independent evaluation | Not assessed | Detection value, false positives, fairness, reproducibility, investigator efficiency, security, and process-completion report | Independent evaluation panel |
| 32 | CMS/Information Regulator engagement | Not assessed | Documented engagement appropriate to the service boundary and approved pilot posture | Principal Officer/Information Officer |
| 33 | Production launch review | Not assessed | Signed go-live record covering schema, commit, models, routes, identities, backups, canary, residual risks, and rollback | Executive/board authority |

## Mandatory Product Invariants

The following invariants apply before and after production qualification:

- A score, rule hit, or network relationship is an investigative signal only.
- ClaimGuard does not automatically stop, reject, delay, redirect, or recover a benefit payment.
- An investigator report does not automatically activate a network notice.
- A separate authorised human decision and sharing approval are required.
- A receiving scheme independently decides whether to investigate.
- The historical audit trail is append-only, while active notices remain correctable, withdrawable, appealable, supersedable, and expirable.
- Production is never initialised from a staging database dump.
- Synthetic claims and identities never enter a real scheme's production route.

## Explicit Non-Claims

- Repository tests do not establish production readiness.
- A working Azure deployment does not establish regulatory, privacy, security, or model approval.
- A model's apparent accuracy on generated claims does not establish real-world validity.
- A hash chain does not prove that an investigation outcome was correct.
- Tokenisation does not make personal information anonymous.
- Historical infrastructure names do not determine the environment's approved classification.

## Initial Pilot Rule

The preferred initial evaluation is a single-scheme silent-mode pilot. ClaimGuard may score and create simulated or internal cases, but it may not withhold, reject, recover, notify, sanction, or alter payment during that evaluation.

Cross-scheme production sharing begins only after the privacy-preserving linkage, prior-authorisation, contracting, network-governance, security, and pilot gates are approved.