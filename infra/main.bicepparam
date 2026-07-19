using './main.bicep'

param location = 'southafricanorth'
param workerIdentityName = 'claimguard-report-worker-identity'
param containerRegistryName = 'claimguardacr11e'
param keyVaultName = 'claimguard-kv-ufs'
param controlPlaneSecretName = 'claimguard--api--control-plane-mysql-url'
param operationalSecretName = 'claimguard--api--mysql-url'
param reportWorkerPrivateSecretNames = []
param reportStorageAccountName = 'cgrpt0715sa'
param reportStorageContainerName = 'claimguard-reports'
param githubActionsPrincipalId = 'fe7b2935-7f00-4996-a0c6-7f3be2390dbb'
param provisionerIdentityName = 'claimguard-provisioner-identity'
