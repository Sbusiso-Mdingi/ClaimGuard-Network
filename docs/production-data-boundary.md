# ClaimGuard Production Data Boundary

## Purpose

This document defines the boundary between non-production and production ClaimGuard environments. It applies to databases, queues, storage, identities, models, reports, logs, backups, credentials, and operational records.

The governing principle is:

> Promote code, schemas, approved models, and approved reference/configuration data. Never promote synthetic claim history.

## Approved Environment Structure

### Development

- Local resources and generated claims.
- Disposable databases, queues, and credentials.
- No real patient, provider, dependant, or medical-scheme data.

### Staging

- Current Azure environment until a clean production environment is provisioned and approved.
- Ubuntu and other synthetic schemes.
- Synthetic claims, model testing, migration rehearsals, and release qualification.

### Production

- Separate databases, queues, identities, secrets, storage, telemetry, ingestion credentials, backups, and endpoints.
- Real medical schemes only.
- Empty operational stores plus approved schema, models, reference data, roles, and configuration.

### Production canary

- Dedicated internal synthetic-only tenant.
- Isolated database, queue, storage, identity, and credentials.
- Exports, billing, external reports, and network sharing disabled.
- Used only for non-destructive verification in production infrastructure.

## What Production Receives

Production is provisioned with:

- versioned database schema and migrations;
- ICD-10, tariff, and other approved reference data;
- provider-type definitions;
- model catalogue entries without automatic activation for a real tenant;
- default roles and permissions;
- approved production configuration;
- empty operational tables.

An explicit, idempotent seed command inserts only approved reference and configuration records.

## What Production Never Receives

Production is not initialised with:

- Ubuntu claims, members, dependants, or providers;
- synthetic identities;
- staging tenant records;
- existing outbox jobs or queue messages;
- dead-letter messages;
- detection results or reports;
- investigation cases or evidence;
- staging audit records;
- staging API credentials or secrets;
- a staging database dump;
- development or CI fixtures.

## Separation Beyond the Database

A valid production boundary requires separate:

- MySQL server and operational databases;
- control-plane database;
- Service Bus namespace and queues;
- Container App and App Service managed identities;
- Key Vault and secrets;
- storage account, containers, reports, and latest pointers;
- Application Insights, Log Analytics, and external telemetry destinations;
- API ingestion credentials;
- backup stores and restore destinations;
- DNS endpoints or deployment environments;
- CI/CD identities and approval gates.

A new production database with an old shared queue is not isolated. Staging work could still be delivered to production workers or vice versa.

The staging scorer must be technically incapable of accessing production databases, queues, storage, or secrets. Production identities must be equally incapable of accessing staging tenant routes.

## Dynamic Tenant Routing

The control plane owns environment-aware tenant routes:

```text
tenant_id
environment
operational_database_route
queue_route
storage_route
active_strategy_id
status
```

Each authenticated identity resolves to exactly one tenant and environment-specific route. The API, worker, and administration operations stop when the authenticated tenant or environment disagrees with the resolved database, queue, storage, or strategy route.

Ubuntu is a staging-only test scheme and is not embedded in deployment, migration, or seed scripts. New schemes are onboarded through audited control-plane operations without code changes.

The architecture supports:

- a dedicated operational database per scheme; and
- an approved shared production data plane for smaller schemes where strict tenant isolation is independently evidenced.

Database-per-scheme is the preferred option for sensitive or higher-risk deployments.

## Safe Go-Live Process

A future production launch follows this sequence:

1. Provision empty production databases, queues, storage, identities, Key Vault, telemetry, backups, and endpoints through infrastructure as code.
2. Verify that staging identities have no production permissions and production identities have no staging permissions.
3. Apply versioned, backward-compatible schema migrations.
4. Run the approved reference/configuration seed operation.
5. Register the baseline model catalogue without activating a strategy for a real tenant.
6. Create the first real tenant through an audited onboarding operation.
7. Allocate the tenant's database, queue, storage, identity, and credential routes.
8. Configure its approved detection strategy without enabling adverse automatic actions.
9. Keep recovery and replay workers parked until route validation is complete.
10. Run migration validation and read-only health checks.
11. Submit synthetic canary claims only through the isolated production-canary route.
12. Confirm authentication, route isolation, scoring, audit events, outbox behaviour, report publication, and telemetry classification.
13. Issue the real scheme's ingestion credentials.
14. Enable real ingestion under the approved go-live change record.
15. Monitor the first claims, jobs, reports, access events, and route resolutions closely.

The signed go-live record captures:

- schema version;
- application commit and deployment artifact;
- model deployment and strategy version;
- tenant database, queue, storage, and identity routes;
- secret and credential versions;
- backup configuration and residency;
- canary evidence;
- approvals and named accountable owners.

## Rollback Rule

Once the production environment receives its first real claim, it remains the authoritative production data store.

Rollback means:

- deploying the previous compatible application version;
- pausing new ingestion where necessary;
- keeping the production database authoritative;
- replaying only new, audited production work where safe;
- preserving queue and outbox provenance;
- recording every rollback decision and data repair.

Rollback never means:

- reconnecting the application to the old synthetic database;
- restoring staging rows into production;
- copying production data into staging;
- replacing production with a staging database dump.

Schema changes use an expand-and-contract approach so the previous and new application versions can temporarily operate against a compatible production schema.

## Production Canary Testing

The production canary is similar to:

```text
tenant: claimguard-internal-canary
classification: synthetic-only
database route: isolated
queue route: isolated
storage route: isolated
reports/export/billing: disabled
external network sharing: disabled
```

It verifies:

- authentication and credential resolution;
- tenant and environment route enforcement;
- ingestion and idempotency;
- transactional outbox processing;
- scoring and model resolution;
- report publication and latest-pointer behaviour;
- audit-event creation;
- telemetry redaction and classification.

Synthetic canary data never shares a real scheme's route and never appears in external reports, billing, recovery, or network intelligence.

## Backup, Residency, and Restore

Before production is created, the accountable organisations approve:

- backup region and residency;
- point-in-time retention;
- zone-redundant or geo-redundant storage choice;
- restore access and separation of duties;
- legal holds;
- deletion and natural backup-expiry rules;
- encryption and key ownership;
- restoration test frequency.

A backup is not accepted as reliable until a non-destructive restoration exercise has succeeded and the restored data has been validated.

The retention schedule covers:

- live claims and reference records;
- investigation and decision records;
- audit events;
- generated reports;
- scoring inputs, features, explanations, and model versions;
- application and security logs;
- queue messages and dead letters;
- backups and restored copies.

When deletion or correction is required, the system records how it propagates to reports, current network notices, replicas, exports, and backups, or when the applicable backup naturally expires. Legal retention periods must be approved separately before fixed durations are configured.

## Privacy and Data Handling Rules

Real patient and scheme data is prohibited in:

- development and CI;
- screenshots and demo recordings;
- BrowserStack, Percy, or similar visual-testing services;
- support tickets and chat channels;
- non-production model-training datasets;
- public issue trackers;
- local developer backups.

Logs and telemetry redact or omit names, identity numbers, membership numbers, provider identifiers where unnecessary, authorisation headers, tokens, diagnosis details not needed for operations, and raw claim payloads.

Every production transfer is recorded in the privacy data-flow inventory with:

- fields and purpose;
- lawful justification;
- storage location;
- permitted users and services;
- retention and deletion rules;
- responsible-party/operator classification;
- sub-operators and countries involved.

## Human-Supervised Fraud Scoring

Production scoring:

- produces risk scores, reasons, and evidence references;
- refers suspicious claims to authorised scheme personnel;
- does not automatically reject, suspend, delay, or redirect benefits;
- records model deployment, feature/input provenance, score, and reason codes;
- supports correction, representation, review, and appeal workflows;
- preserves the eventual authorised human decision and its reasons.

## Security and Supply-Chain Controls

Preferred Azure-native controls include:

- Microsoft Entra ID with MFA, role separation, and conditional access;
- Azure Key Vault with managed identities and rotation tracking;
- Azure Monitor/Application Insights with aggressive telemetry redaction;
- Microsoft Defender for Cloud;
- Azure Policy for region, network, encryption, and public-access restrictions;
- Microsoft Purview when proportionate and affordable.

Repository and CI controls include:

- Gitleaks;
- Trivy;
- OWASP ZAP for controlled test environments;
- Semgrep Community;
- Dependabot;
- SBOM generation with Syft;
- image signing and verification with Cosign.

These tools do not receive production patient data.

## Breach Response

A suspected compromise triggers:

1. identification and containment;
2. preservation of evidence;
3. determination of affected environments, tenants, identities, and records;
4. immediate escalation to the Information Officer and accountable scheme contacts;
5. assessment and preparation of required notifications;
6. credential and identity containment;
7. correction, restoration, and monitored recovery;
8. a recorded timeline, decisions, remediation, and follow-up review.

Any cross-tenant or cross-environment access is a stop-the-line incident.