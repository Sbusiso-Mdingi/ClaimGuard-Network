# ClaimGuard Network — Technical Specification

**A privacy-preserving, cross-scheme fraud intelligence platform for South African medical schemes**

**Author:** Sbusiso Mdingi
**Status:** Production-shaped Architecture (v1.2)

**Revision notes (v1.2):** replaced the in-repository generated-data workflow with authenticated external claim ingestion, atomic reference/claim persistence, and durable outbox-driven report production.

---

## 1. Overview

Medical schemes in South Africa each run their own fraud, waste, and abuse (FWA) detection in isolation. A provider or member blacklisted by one scheme can register under a new practice number, banking detail, or dependant record at another scheme entirely undetected. Current industry solutions are static and manual.

ClaimGuard Network's model draws on two real, verified South African precedents. **SAFPS** (South African Fraud Prevention Services) already runs a shared fraud-listings database across industries. **SABRIC** (South African Banking Risk Information Centre) — a non-profit set up by the banking industry itself — goes further, and is currently, publicly repositioning toward predictive analytics and privacy-preserving analytics: moving from reactive reporting to real-time, proactive intelligence. That's the exact direction ClaimGuard takes for healthcare, in an industry that hasn't built its version of it yet.

ClaimGuard allows multiple schemes to contribute claims signals to a shared fraud-detection graph **without exposing raw member or provider PII to each other**. Fraud rings and repeat offenders that are invisible to any single scheme become visible at the network level.

The current build accepts claims only through an authenticated, tenant-scoped ingestion boundary. External medical-aid systems or approved test producers own data creation; ClaimGuard validates and persists their reference records and claims, then queues detection through a durable transactional outbox.

---

## 2. Problem Statement & Goals

**The Problem:** Schemes lose billions annually to FWA. Fraudulent actors move easily between schemes because there is no real-time, graph-based, cross-scheme entity resolution. Furthermore, aggressive blacklisting without due process invites defamation lawsuits and Council for Medical Schemes (CMS) penalties.

**Goals:**
- **Tokenized Architecture:** Raw PCNS numbers and IDs must never leave the medical scheme's firewall — only keyed, tokenized values cross the boundary. (Note: this is tokenization/pseudonymization, not zero-knowledge in the cryptographic sense — see §4 for the honest version of what this guarantees.)
- **Cross-Scheme Resolution:** Demonstrate that an entity flagged at Scheme A can be re-identified at Scheme B using tokenized fields and behavioral signals.
- **Actuarial Integration:** Combine frequency-severity GLM anomaly scoring with graph machine learning.
- **Legal Defensibility:** Implement a strict 3-Stage data state machine and an immutable audit ledger honoring the *audi alteram partem* principle.
- **Professional Engineering:** Build a highly observable system using professional full-stack and DevOps tooling.

---

## 3. System Architecture & Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Client Edge** | Python SDK (`claimguard-sdk`) | Local, behind-the-firewall tokenization of PII |
| **API Gateway** | tRPC, Hono | Edge-compatible routing, designed for low-latency claims switchboard traffic |
| **Relational DB** | MySQL (via Drizzle ORM) | Fast lookups, state machine management, cryptographic ledger |
| **Graph DB** | Azure Cosmos DB (Gremlin API) | Core fraud network and cross-scheme relationship traversals |
| **Producer Runtime** | Azure Container Apps Jobs (Python) | Scheduled/event-driven orchestration for detection runs |
| **Report Storage** | Azure Blob Storage | Versioned reports, metadata, and latest pointer (`latest.json`) |
| **Frontend UI** | React 19, TypeScript, Tailwind CSS | Rapid, type-safe investigator dashboard |
| **Observability** | New Relic & Sentry | Distributed tracing, APM, source-mapped error tracking |
| **CI/CD & Sec** | GitHub Actions, Codecov, AstraSecurity | Automated pipelines, coverage gating, vulnerability scanning |
| **Secrets/Identity** | Azure Key Vault + Managed Identity | Secret boundary and least-privilege runtime access |

(The "sub-50ms" latency figure from the earlier draft has been removed — it's a reasonable design target for tRPC/Hono, but not a claim to make before anything is built and measured. Worth quoting once you actually benchmark it.)

---

## 4. The Tokenized Edge SDK (The Anonymizer)

To guarantee POPIA-aligned handling, raw identifiers must never hit the platform's API gateway.

**Implementation:**
The platform provides a lightweight Python package that medical schemes install locally. Python is the standard language for data teams in this space, making integration seamless.

1. The scheme holds a unique, rotatable `Scheme_Key` in its own local secret store — never transmitted, never shared.
2. The SDK performs a **keyed HMAC-SHA256** operation: `HMAC-SHA256(PCNS_Number, Scheme_Key)`.
3. The SDK transmits only the resulting token to the ClaimGuard API Gateway.

**Why HMAC instead of a simple salted hash:** a plain `SHA256(id + salt)` construction is weaker than it looks for structured, low-entropy identifiers like South African ID numbers, which encode date of birth, gender, and a checksum — the space of valid ID numbers is far smaller than the hash space suggests, so if a salt is ever exposed or reused broadly, it becomes feasible to enumerate and match against it offline. A keyed HMAC with a securely managed, rotatable key is deliberately built to resist exactly this: the key must remain secret, can be rotated without reissuing the whole scheme's tokens from scratch, and doesn't rely on the salt's secrecy the way the original construction implicitly did.

**Known limitation, stated honestly:** HMAC alone doesn't reach a formal cryptographic privacy guarantee against an attacker who obtains the key — it raises the bar substantially over plain hashing, but it isn't equivalent to zero-knowledge or secure multi-party computation. The fuller solution, noted as future work in this spec's roadmap, is either a Bloom-filter-based PPRL construction (cryptographic long-term keys, purpose-built for this exact problem) or a mediated linkage computation where no single party — including ClaimGuard — ever holds a key capable of unmasking another scheme's tokens alone. Worth being upfront about this distinction if a technical reviewer asks, rather than letting "tokenized" imply more than it delivers.

By decoupling the encryption from the API, the central platform is protected from most classes of data breach, though not from a compromise of a scheme's own key store — which is a reasonable and honestly stated boundary for this design.

---

## 5. The 3-Stage Fraud Lifecycle

To prevent defamation lawsuits and satisfy the CMS, the platform enforces a strict data state machine governed by the MySQL relational layer.

* **State 1: YELLOW FLAG (Pending Investigation)**
  * *Trigger:* Statistical anomaly engine detects highly anomalous billing patterns.
  * *Action:* A temporary, tokenized alert is logged. It is invisible to other schemes' automated payment engines, but triggers high-risk warnings for manual forensic review if massive bulk claims are submitted elsewhere.
* **State 2: VERIFIED MATCH (Patient Verification)**
  * *Trigger:* Scheme investigator manually confirms fraud (e.g., patient confirms they never saw the doctor).
  * *Action:* Scheme uploads a cryptographic "Proof of Misrepresentation" token. Other schemes can now pause automated multi-claim payouts to that provider to limit financial exposure.
* **State 3: RED FLAG (Permanent Tag)**
  * *Trigger:* Legal due process complete; provider contract terminated.
  * *Action:* The provider's tokenized PCNS is moved to the immutable blacklist. All subsequent claims across the network are instantly routed for rejection.

---

## 6. Immutable Multi-Tenant Audit Trail (The Ledger)

If a provider sues for loss of income, the platform must prove *which* scheme verified the fraud and *when*.

Instead of heavy infrastructure like Hyperledger, this POC utilizes a **hash chain** — a tamper-evident log, not a full Merkle tree (a Merkle tree branches to allow efficient proof of membership within a set; this is simpler: a linked chain where each row incorporates the previous row's hash, closer in spirit to how a blockchain links blocks) — within the existing MySQL setup.

```typescript
export const cryptographicLedger = mysqlTable("cryptographic_ledger", {
  id: serial("id").primaryKey(),
  tokenizedPcns: varchar("tokenized_pcns", { length: 256 }).notNull(),
  previousRowHash: varchar("prev_hash", { length: 256 }).notNull(),
  newState: fraudStatusEnum.notNull(), // YELLOW, VERIFIED, RED
  schemeOfficerSignature: text("officer_sig").notNull(),
  timestamp: timestamp("timestamp").defaultNow(),
  currentRowHash: varchar("current_hash", { length: 256 }).notNull(),
});
```

Any attempt to alter historical records breaks the `previousRowHash` chain, providing mathematical proof of tampering and shifting liability away from ClaimGuard.

---

## 7. Graph Engine & Entity Resolution

While MySQL handles the legal lifecycle, the graph database (Azure Cosmos DB — Gremlin API) handles the behavioral detection.

**Entity Resolution (PPRL):**
Where identifiers have been deliberately altered post-tokenization (evasion), the system falls back to fuzzy matching on non-identifying behavioral features (e.g., billing code cosine similarity, claim timing correlations, specialty matches). These components are weighted to form a confidence score.

**Graph Traversal:**
- Vertices: `scheme`, `member`, `provider`, `claim`, `resolved_entity`
- Edges: `submitted`, `billed_by`, `paid_by`, `shares_banking`, `referred_by`

---

## 8. Actuarial Detection Engine

The engine fuses standard actuarial methodology with graph machine learning.

**Statistical Anomaly Scoring (GLM):**
Expected claims costs and frequencies are modeled via a frequency-severity GLM. Compute-heavy model execution runs in Azure-native worker runtimes so it remains isolated from the API request path.

**Graph ML:**
- **Community Detection:** Louvain modularity optimization identifies dense clusters.
- **Centrality:** Betweenness centrality uncovers "hub" entities connecting multiple flagged actors.
- **Risk Propagation:** A flag on an entity in one scheme propagates a risk multiplier to linked identities across the network.

---

## 9. Observability & CI/CD Pipeline

To emulate a high-performing engineering team, local development and deployments are heavily automated.

- **Continuous Integration:** GitHub Actions runs on every pull request.
- **Quality Gates:** Codecov blocks PRs if test coverage drops below 70%. AstraSecurity scans dependencies for CVEs and statically analyzes code.
- **Application Performance (New Relic):** Tracks p99 latency for tRPC endpoints and business metrics (e.g., "Entity Resolution Accuracy").
- **Error Tracking (Sentry):** Captures exceptions with source-mapped stack traces.
- **Authoritative Inputs:** Claims and their scheme, member, and provider references arrive through the authenticated ingestion contract. Production report generation reloads a tenant-scoped database snapshot rather than accepting ad hoc files.

---

## 10. Build Roadmap (12 Weeks)

| Phase | Scope | Core Tooling |
|---|---|---|
| 0 | Environment Setup: GitHub Actions, Codecov, Sentry, New Relic, Doppler, monorepo setup | Actions, Doppler, Sentry |
| 1 | Claim Ingestion: external producer contract, validation, persistence, and outbox | Hono, Zod, MySQL |
| 2 | Client SDK: Python Edge SDK for local tokenization | Python, PyPI structuring |
| 3 | Backend Foundation: tRPC API + Hono + Drizzle ORM + Auth + Hash-Chained Ledger | tRPC, Drizzle, MySQL |
| 4 | Detection Engine + Producer Runtime: Azure Container Apps Jobs + Blob Storage + Cosmos DB graph analytics | ACA Jobs, Blob Storage, Gremlin |
| 5 | Investigator UI: React 19 + shadcn/ui + network graph visualization | React, Tailwind, Vite |
| 6 | Observability & CI/CD: Sentry release tracking, AstraSecurity scanning, custom dashboards | AstraSecurity, New Relic |
| 7 | Evaluation & Polish: Measure accuracy against seeded evasion cases, write documentation | Markdown |
