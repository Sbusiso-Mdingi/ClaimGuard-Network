using './report-worker.bicep'

param location = 'southafricanorth'
param containerAppsEnvironmentName = 'claimguard-env-11e'
param containerRegistryName = 'claimguardacr11e'
param workerIdentityName = 'claimguard-report-worker-identity'
param keyVaultName = 'claimguard-kv-ufs'
param controlPlaneSecretName = 'claimguard--api--control-plane-mysql-url'
param operationalSecretName = 'claimguard--api--mysql-url'
param modelPseudonymSecretName = 'claimguard--report-worker--model-pseudonymization-key'
param modelServiceBaseUrl = 'https://claimguard-ml-inference.livelydune-39b25d2c.southafricanorth.azurecontainerapps.io'
param modelServiceAudience = readEnvironmentVariable('CLAIMGUARD_AZURE_MODEL_SERVICE_AUDIENCE')
param modelDeploymentId = 'claimguard-claim-fraud-ensemble:1.1.0'
param modelPseudonymizationKey = readEnvironmentVariable('CLAIMGUARD_AZURE_MODEL_PSEUDONYMIZATION_KEY')
param reportWorkerImage = readEnvironmentVariable('CLAIMGUARD_AZURE_REPORT_WORKER_IMAGE')
param reportStorageAccountUrl = 'https://cgrpt0715sa.blob.core.windows.net'
param reportStorageContainerName = 'claimguard-reports'
param reportWorkerJobName = 'claimguard-report-producer'
