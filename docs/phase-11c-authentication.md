# Phase 11C authentication history

Phase 11C originally introduced local-password sessions. That production model has been superseded by the governed Clerk workforce boundary in [`clerk-workforce-authentication.md`](clerk-workforce-authentication.md).

Local-password routes and services remain only as isolated compatibility fixtures for automated tests. Runtime configuration rejects `AUTHENTICATION_MODE=session` unless `NODE_ENV=test`. Production and developer runtime start in Clerk mode, never display demo credentials, and never accept browser-controlled identity headers.

Operational database routing remains server authoritative. A verified Clerk user and active Clerk organisation are mapped to one active internal user, membership, organisation, role set, and data-plane route before any request receives authority.

External claim producers continue to use separately scoped integration credentials documented in [`claim-ingestion.md`](claim-ingestion.md); they never authenticate as workforce users.

There is no password-mode incident fallback. Restore the Clerk, control-plane database, origin, or organisation-mapping dependency and keep the application fail closed.
