# ClaimGuard Environment Matrix

ClaimGuard requires explicit environment separation so that demo and production never share databases, secrets, identities, or report partitions.

## Environment Definitions

| Environment | Purpose | Reset policy | Data classification | Scenario Lab allowance | Deployment approval |
| --- | --- | --- | --- | --- | --- |
| Local development | developer inner loop | disposable | synthetic only | allowed only in future isolated lab code paths | none |
| Automated test | CI validation | disposable | synthetic/test | not allowed | pipeline gates only |
| Demo | pilot demonstration | controlled reset only | synthetic/demo-only | not allowed | operator-controlled |
| Staging | release qualification | controlled reset only | synthetic or scrubbed | not allowed | approved promotion |
| Production | customer-facing live operation | no demo reset | real customer data only | reject Scenario Lab identities | formal approval only |

## Current Azure Environment Snapshot

### Shared subscription and resource group

- Subscription: Azure for Students
- Subscription ID: `896d3c72-d979-4bdc-a37f-060988d12032`
- Tenant: `8efc1bb9-b90f-4a48-bf6c-ba0686193b80`
- Resource group: `ClaimGuard`

### Current live services in scope

| Resource | Purpose | Notes |
| --- | --- | --- |
| `claimguard-api` | API | publicly reachable, system-assigned identity present |
| `claimguard-web` | web frontend | publicly reachable, no identity present |
| `claimguard` | MySQL Flexible Server | public network enabled |
| `claimguard-kv-ufs` | Key Vault | public network enabled, RBAC mode |
| `cgrpt0715sa` | Storage account | HTTPS only, blob public access disabled |
| `claimguardacr11e` | ACR | container image registry for worker images |
| `claimguard-env-11e` | Container Apps environment | hosts worker/job runtime |
| `claimguard-provisioning-worker` | Container Apps job | uses user-assigned managed identity |

## Functional Separation Rules

- Production must never accept demo reset operations.
- Production must reject future Scenario Lab identities.
- Demo and production must not share databases, secrets, identities, or report partitions.
- Future contracted organisations must begin with clean private databases.
- Demo must be explicitly labeled as demo even if technically hardened.
- Do not switch demo and production by replacing one connection string.

## Environment Matrix

| Dimension | Local | Test | Demo | Staging | Production |
| --- | --- | --- | --- | --- | --- |
| Resource group | local only | CI ephemeral | demo RG | staging RG | production RG |
| Subscription | local/dev subscription | CI subscription | demo subscription | staging subscription | production subscription |
| Hostnames | localhost | ephemeral | demo hostnames | staging hostnames | production hostnames |
| Control-plane DB | local/test DB | ephemeral DB | demo control-plane DB | staging control-plane DB | prod control-plane DB |
| Tenant DBs | local/test DBs | ephemeral DBs | demo synthetic DBs | staged private DBs | clean private DBs |
| Key Vault | local secret store | ephemeral | demo KV | staging KV | prod KV |
| Doppler config | dev | test | demo | staging | production |
| Identities | local creds | CI identity | demo UAMIs | staging UAMIs | prod UAMIs |
| Storage | local files | ephemeral | demo blob storage | staging blob storage | prod blob storage |
| Telemetry | local console | CI logs | demo telemetry | staging telemetry | prod telemetry |
| Deployment approval | none | pipeline | operator | release owner | formal change control |
| Destruction/reset | allowed | allowed | controlled | controlled | prohibited |

## Current Gap

Staging is not yet evidenced as a separate live environment in the repository or Azure inventory. The safest near-term path is a cost-aware staging plan with minimal reproducible infrastructure rather than accidental reuse of demo or production resources.
