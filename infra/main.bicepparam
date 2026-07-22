using './main.bicep'

param location = 'southafricanorth'
param workerIdentityName = 'claimguard-report-worker-identity'
param containerRegistryName = 'claimguardacr11e'
param containerAppsEnvironmentName = 'claimguard-env-11e'
param keyVaultName = 'claimguard-kv-ufs'
param controlPlaneSecretName = 'claimguard--api--control-plane-mysql-url'
param operationalSecretName = 'claimguard--api--mysql-url'
param reportWorkerPrivateSecretNames = []
param reportStorageAccountName = 'cgrpt0715sa'
param reportStorageContainerName = 'claimguard-reports'
param githubActionsPrincipalId = '836d3065-119d-4dae-94b4-f29304e1938d'
param provisionerIdentityName = 'claimguard-provisioner-identity'
