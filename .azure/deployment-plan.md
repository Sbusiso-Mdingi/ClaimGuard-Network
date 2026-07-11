# ClaimGuard Network Azure Deployment Plan

## Status
- In progress

## Goal
- Prepare this monorepo for Azure-hosted deployment using azd-style infrastructure and cloud services.

## Assumptions
- Target Azure deployment path is Azure App Service for the API and web apps.
- The current repo already has the application code and local end-to-end wiring in place.
- External cloud services such as MySQL, Sentry, and New Relic will be configured through environment-managed secrets.
- Existing Azure resources in the `ClaimGuard` resource group include MySQL, a Linux App Service plan, two App Service apps, and a Key Vault.

## Phase 1: Analysis
- Identify the deployable app components and shared packages.
- Confirm whether the target is Azure Container Apps, App Service, or another Azure host.
- Confirm subscription and region before provisioning.

## Phase 2: Infrastructure Design
- Host the API and web UI on Azure App Service.
- Keep the Python detection engine local for report generation unless a later phase requires cloud execution.
- Use Azure Key Vault as the secret boundary that will later be populated from Doppler-managed values.
- MySQL already exists in Azure and will be wired into the API via environment configuration.

## Phase 3: Artifact Generation
- Create Azure deployment configuration.
- Add infrastructure-as-code files under `infra/`.
- Add any required Dockerfiles or build metadata.

## Phase 4: Validation
- Run local checks for the generated Azure artifacts.
- Validate the planned Azure deployment path before any deployment execution.

## Open Questions
- Which Azure region should be used?
- Should the deployment include only the web/API or the detection engine as well?
- Are Azure MySQL, Key Vault, and ACR all required in the first cloud pass?