# ClaimGuard Network — Technical Specification

**A privacy-preserving claims-risk, investigation, and cross-scheme intelligence platform for South African medical schemes**

**Author:** Sbusiso Mdingi  
**Status:** Production-shaped architecture; not yet approved for live medical-scheme use

> ClaimGuard is an internal project name. It is not a final commercial brand and must not be treated as evidence of trademark clearance.
>
> Documented capabilities describe the target architecture. They are not evidence of a live medical-scheme integration, regulatory approval, production readiness, or completed legal review.

---

## 1. Product purpose

ClaimGuard helps medical schemes identify suspicious claims, organise scheme-controlled investigations, preserve evidence, and share bounded intelligence about properly authorised investigation outcomes.

ClaimGuard does **not**:

- determine that a provider, member, dependant, employee, or other person is guilty of fraud;
- automatically reject, suspend, delay, or redirect a claim or benefit payment;
- instruct another scheme to terminate a provider or member relationship;
- impose recovery, sanction, or contractual consequences;
- replace the scheme's investigators, authorised decision-makers, policies, or statutory obligations.

The platform produces risk signals and explainable evidence. The relevant scheme decides whether those signals justify an investigation. The scheme's authorised investigators perform that investigation under the scheme's approved procedures. Any final outcome is based on the investigation record and an authorised human decision, not on ClaimGuard's model score.

Where a scheme records an eligible substantiated outcome, ClaimGuard may distribute a bounded network notice to participating schemes. That notice is an investigative lead only. Each receiving scheme remains responsible for verifying the match, assessing its own claims, and making its own lawful decisions.

---

## 2. Core design principles

### 2.1 Human-supervised scoring

- Models, rules, and graph analytics generate signals, scores, reason codes, and evidence references.
- A signal has no direct payment, recovery, sanction, or contractual effect.
- An authorised scheme user decides whether to dismiss, monitor, or investigate the signal.
- The model deployment, input provenance, feature lineage, score, reason codes, and relevant evidence snapshot are retained.
- Any adverse outcome requires a documented human-controlled process and decision.

### 2.2 Scheme accountability

ClaimGuard supplies software and analytical services under scheme-controlled workflows. The scheme retains responsibility for:

- investigation initiation;
- provider or member communications;
- evidence requests and assessment;
- clinical, coding, legal, and forensic judgment;
- findings, reasons, appeals, corrections, recoveries, sanctions, and payment decisions;
- compliance with its rules, contracts, the Medical Schemes Act, POPIA, PAJA-grade fairness expectations, and applicable CMS requirements.

### 2.3 Immutable history, correctable status

ClaimGuard distinguishes between:

1. **Append-only historical events**, which preserve who recorded or changed an outcome, when, under which process version, and with which evidence reference; and
2. **Current active status**, which can be corrected, withdrawn, superseded, appealed, suspended, or expired.

The platform does not maintain a permanent, uncorrectable blacklist. A historical event may remain auditable while the active network notice is removed or updated.

### 2.4 Data minimisation and tenant isolation

- Raw identifiers are processed at the scheme-controlled edge where possible.
- Raw scheme-private claims are not exposed to other schemes.
- Platform administrators do not receive routine access to scheme-private claims.
- Cross-scheme notices reveal only the minimum authorised information necessary to communicate a prior outcome and its provenance.
- Tenant and environment routes are resolved by the control plane and enforced by every API, worker, storage, and administrative operation.

---

## 3. Runtime architecture

| Layer | Technology | Purpose |
|---|---|---|
| Client edge | Python SDK | Local tokenisation/pseudonymisation and authenticated ingestion |
| API gateway | Hono and tRPC | Tenant-scoped ingestion, administration, and read APIs |
| Operational database | MySQL via Drizzle ORM | Claims, outbox work, investigations, decisions, routes, and audit events |
| Graph layer | Azure Cosmos DB Gremlin API or approved equivalent | Relationship construction and network-risk analysis |
| Producer runtime | Azure Container Apps Jobs | Durable orchestration of scoring and report production |
| Report storage | Azure Blob Storage | Versioned reports, metadata, and latest pointers |
| Investigator UI | React, TypeScript, Tailwind CSS | Scheme-controlled triage, investigation, evidence, and decision workflows |
| Secrets and identity | Azure Key Vault and managed identities | Least-privilege runtime identity and secret delivery |
| Observability | Approved Azure and external telemetry services | Operational monitoring with strict data redaction and environment separation |

The API, workers, control plane, tenant databases, queues, storage, identities, credentials, and telemetry destinations are environment-specific. A non-production identity must be technically incapable of reaching production data-plane routes, and production identities must not reach non-production tenant data.

---

## 4. Edge privacy and linkage

The edge SDK applies keyed HMAC-SHA256 or an approved successor mechanism to configured identifiers before transmission. This is pseudonymisation, not anonymity and not a complete cross-scheme linkage solution by itself.

A scheme-specific HMAC key protects tenant identifiers but normally produces different tokens for the same identifier at different schemes. Cross-scheme linkage therefore requires a separately governed privacy-preserving linkage design. Candidate approaches include:

- mediated private-set intersection;
- an oblivious pseudorandom function;
- a secure enclave with split-key governance;
- a validated privacy-preserving record-linkage protocol.

The approved design must reveal only the minimum match assertion, confidence, contributing fields, provenance, and sharing authority. No universal re-identification key may be made available to ClaimGuard or participating schemes.

---

## 5. Claims-risk and investigation lifecycle

ClaimGuard uses the following target lifecycle.

| State | Purpose and control |
|---|---|
| `SIGNAL_GENERATED` | A rule, model, or network signal is recorded with reasons and provenance. It has no payment effect. |
| `TRIAGE_PENDING` | A scheme analyst checks data quality, jurisdiction, duplicate cases, and conflicts. |
| `DISMISSED` | The signal is closed without investigation, with a recorded reason. |
| `MONITORING` | The scheme elects to monitor additional activity without opening an investigation. |
| `INVESTIGATION_OPEN` | An authorised scheme user opens a case and preserves the relevant data/model snapshot. |
| `NOTICE_RECORDED` | Where required, notice, affected claims, allegations, and proof of delivery are recorded. |
| `RESPONSE_PENDING` | The case remains open while representations or supporting records are awaited. |
| `EVIDENCE_REVIEW` | Investigators assess claims, patient verification, coding/clinical input, documents, and representations. |
| `INVESTIGATION_REPORT_COMPLETED` | The investigator records findings and supporting evidence. The report cannot itself activate a network notice. |
| `OUTCOME_REVIEW_PENDING` | An authorised decision-maker independently reviews the report, process completion, identity match, evidence, and sharing authority. |
| `OUTCOME_APPROVED` | A human decision-maker records the authorised outcome, reasons, scope, dates, and review rights. |
| `NETWORK_NOTICE_ACTIVE` | An eligible, substantiated outcome is shared as a bounded investigative lead. It does not direct another scheme's decision. |
| `CLOSED_UNSUBSTANTIATED` | No substantiated concern remains; current risk status is removed and corrections are propagated. |
| `CORRECTED_OR_WITHDRAWN` | The current notice is corrected or withdrawn while the historical audit event is retained. |
| `APPEAL_OR_REVIEW` | The active outcome is marked with its review status and handled under the applicable process. |
| `EXPIRED_OR_SUPERSEDED` | The notice is no longer active because its approved duration ended or a later outcome replaced it. |

Terms such as `guilty`, `blacklist`, `instant rejection`, `permanent tag`, and `automatic payment pause` are not part of the product's normal domain language.

---

## 6. Network intelligence notice

A network notice communicates a bounded prior outcome, not a universal fraud determination. At minimum it records:

- originating scheme or authorised participant;
- tokenised entity reference and match confidence;
- outcome category and bounded factual description;
- affected claims, service period, or evidence digest where disclosure is authorised;
- investigation procedure and decision version;
- authorised decision-maker role and decision date;
- sharing purpose and authority;
- appeal, review, correction, or withdrawal status;
- active-from, review-by, and expiry dates;
- correction propagation status.

A receiving scheme must independently decide whether the notice and its own information justify triage or investigation. ClaimGuard does not convert a network notice into a payment, recovery, sanction, or contracting instruction.

---

## 7. Investigation and decision controls

The investigation workspace supports:

- evidence and correspondence registers;
- claim-level and entity-level context;
- patient-verification records;
- clinical and coding advice;
- investigator notes and reports;
- provider or member representations;
- conflict and recusal records;
- independent outcome review;
- written reasons;
- review, appeal, correction, withdrawal, and expiry workflows;
- correction propagation to every authorised recipient.

Role separation prevents the detection engine from approving an outcome and prevents an investigator report from activating a network notice without the required decision and sharing approvals.

---

## 8. Audit architecture

ClaimGuard maintains a tamper-evident, append-only event history. Each event records:

- tenant and environment;
- case, signal, outcome, or network-notice identifier;
- previous event hash and current event hash;
- action and state transition;
- actor, role, and authorisation context;
- process, application, schema, and model versions;
- timestamp and correlation identifier;
- evidence or report digest;
- reason for correction, withdrawal, expiry, or supersession where applicable.

The hash chain is evidence of tampering resistance, not proof that the underlying finding was correct. Accuracy, procedural fairness, correction, access control, retention, and independent review remain separate controls.

---

## 9. Environment and production-data boundary

### Development

- Local resources and generated claims only.
- No real patient, provider, dependant, or scheme production data.
- Disposable databases and credentials.

### Staging

- The current Azure environment is treated as non-production until formal production qualification and clean-environment cutover are complete.
- Ubuntu and other synthetic schemes remain staging tenants.
- Synthetic claims, model testing, migration rehearsal, and release qualification occur here.

### Production

- Separate databases, queues, identities, secrets, storage, telemetry, credentials, backups, and deployment endpoints.
- Real medical schemes only.
- Production starts from empty operational stores plus approved schema, configuration, models, and reference data.
- Production is never initialised from a staging database dump.

### Production canary

- A dedicated internal synthetic-only tenant.
- Isolated operational database, queue, storage route, identity, and credentials.
- Reports, exports, billing, and external sharing disabled.
- Used only for non-destructive verification of the production infrastructure.

Application code, schema migrations, approved model definitions, and approved reference/configuration records move toward production. Synthetic claim rows, members, providers, outbox jobs, reports, audit events, and credentials do not.

The authoritative production boundary and safe go-live process are documented in `docs/production-data-boundary.md`.

---

## 10. Tenant routing

The control plane maintains environment-aware routing records equivalent to:

```text
tenant_id
environment
operational_database_route
queue_route
storage_route
active_strategy_id
status
```

Every authenticated identity resolves to exactly one tenant and one environment-specific route. The API, workers, and administrative operations fail closed when the authenticated tenant or environment disagrees with the resolved database, queue, storage, or strategy route.

Ubuntu is a synthetic staging tenant and is not embedded in deployment or migration logic. New schemes are onboarded through audited control-plane operations without application code changes.

The architecture supports:

- a dedicated operational database per scheme; and
- an approved shared production data plane for smaller schemes where rigorous tenant isolation is independently evidenced.

Database-per-scheme remains the preferred option for highly sensitive or higher-risk deployments.

---

## 11. Privacy and security governance

Before real medical-scheme data is processed, the responsible organisations must approve:

- the responsible-party, joint-responsible-party, operator, and sub-operator allocation for each processing activity;
- operator and data-sharing agreements;
- a privacy impact assessment and data-flow inventory;
- the lawful basis and special-personal-information justification;
- prior-authorisation analysis where unique-identifier linkage or unlawful-conduct information is processed;
- retention, deletion, access, correction, and incident-response procedures;
- cross-border transfer and data-location decisions;
- provider/member procedural-fairness policy;
- model governance, fairness, explainability, validation, drift, override, and retirement controls.

Real patient data is prohibited in development, CI, screenshots, support tickets, browser-testing platforms, and non-production model datasets. Logs and telemetry must redact names, identity numbers, membership numbers, authorisation headers, diagnosis details not required for operations, and other sensitive payload fields.

---

## 12. Production qualification

ClaimGuard remains production-shaped rather than production-ready until the documented qualification gates are completed. Required evidence includes:

- legal and privacy approval;
- independent security and cryptographic review;
- penetration testing and remediation;
- backup restoration and disaster-recovery exercises;
- access and RBAC review;
- model validation, fairness analysis, and reproducibility evidence;
- incident-response exercise;
- retention/deletion testing;
- silent-mode historical and prospective pilot results;
- scheme board or delegated-governance approval;
- appropriate CMS and Information Regulator engagement.

The preferred first live evaluation is a single-scheme, silent-mode pilot. ClaimGuard may score and open simulated cases, but cannot withhold, reject, recover, notify, or alter payment during that pilot. Cross-scheme production sharing is deferred until the privacy, linkage, legal, and governance gates are approved.

---

## 13. Build roadmap

| Phase | Scope |
|---|---|
| 0 | Environment, CI, supply-chain, secrets, and repository controls |
| 1 | Tenant-scoped authenticated ingestion and transactional outbox |
| 2 | Edge pseudonymisation SDK and key-management boundaries |
| 3 | Control plane, tenant routing, authentication, and audit events |
| 4 | Detection engine, graph analysis, scoring provenance, and report production |
| 5 | Human-supervised triage and investigation workspace |
| 6 | Independent outcome review, reasons, appeal, correction, withdrawal, and expiry |
| 7 | Privacy-preserving linkage proof and bounded network notices |
| 8 | Environment isolation, production canary, migration, backup, and rollback validation |
| 9 | Independent security, privacy, model, fairness, and regulatory qualification |
| 10 | Silent single-scheme pilot, followed by a controlled two-scheme proof only after approval |

---

## 14. Summary

ClaimGuard is a decision-support and investigation-orchestration platform. Its models identify risk; authorised schemes investigate; authorised humans decide; and any cross-scheme notice remains bounded, reviewable, correctable, and non-determinative. The immutable element is the historical audit trail, not a person's permanently active adverse status.