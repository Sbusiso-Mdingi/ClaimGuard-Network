# Windows desktop producer baseline

The desktop claim producer has not been implemented yet. This document defines the host baseline for that later task and prevents the desktop from becoming a second ClaimGuard server.

## Operating-system gate

Do not process real medical-aid or personal data on an unsupported Windows installation. Standard Windows 10 support ended on 14 October 2025. Prefer Windows 11 Pro. If the hardware cannot upgrade immediately, use Windows 10 22H2 only for non-sensitive simulated claims, enroll it in Microsoft's Extended Security Updates, and replace or upgrade it before ESU ends on 13 October 2026.

Official lifecycle guidance: <https://www.microsoft.com/en-us/windows/end-of-support>

Before connecting the machine:

- install all Windows and firmware updates;
- enable Microsoft Defender, Windows Firewall, Secure Boot, and BitLocker;
- use a dedicated standard Windows account for the producer, not an administrator account;
- enable automatic time synchronization;
- allow outbound HTTPS (`443`) to the ClaimGuard API and deny unnecessary inbound access;
- keep the retry spool on the BitLocker-protected disk with access restricted to the producer account.

## Producer-only software

For the first Python-based producer implementation, install:

- Python 3.12 x64, matching ClaimGuard CI;
- `uv` for an isolated, lockfile-backed Python environment;
- the packaged ClaimGuard edge SDK and desktop producer when they are released;
- PowerShell 7 for installation and operational scripts (recommended, not a runtime dependency).

The producer must store its credential through Windows Credential Manager or a certificate/private-key store, never in source files or a desktop shortcut. It should run as a scheduled task or Windows service, maintain a bounded encrypted retry queue, emit metadata-only logs, and send batches only to `POST /claims/ingest` over TLS.

Do not install MySQL, Azure CLI, Node.js, pnpm, Docker Desktop, or the ClaimGuard server applications on a producer-only machine. The producer needs no inbound port and no direct database or storage access.

## Full development workstation

Only install the following if the desktop will also build the complete repository:

- Git for Windows and GitHub CLI;
- Node.js 24 x64 with Corepack and pnpm 9;
- Python 3.12 x64 and `uv`;
- Visual Studio Code or another editor;
- Docker Desktop or a separate MySQL 8 test instance only when live integration tests are required.

Development tools and credentials must remain separate from the service account that runs the producer.

## Before real data

The current shared bearer token is suitable only for controlled development. Before real medical-aid connectivity, implement per-producer identity, credential rotation and revocation, certificate or Entra workload authentication, signed installer/update delivery, remote health monitoring, queue retention limits, and an incident-disable switch.
