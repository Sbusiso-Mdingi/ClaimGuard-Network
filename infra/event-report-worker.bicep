targetScope = 'resourceGroup'

param location string = resourceGroup().location
param containerAppsEnvironmentName string
param containerRegistryName string
param workerIdentityName string
param keyVaultName string
param controlPlaneSecretName string
param operationalSecretName string
param modelPseudonymSecretName string
param reportWorkerImage string
param storageAccountName string
param reportStorageAccountUrl string
param reportStorageContainerName string = 'claimguard-reports'
param claimScoringQueueName string = 'claimguard-claim-scoring'
param reportWorkerJobName string = 'claimguard-report-producer'
param recoveryJobName string = 'claimguard-report-recovery'
param recoveryScheduleCron string = '0 0 1 1 *'
param modelServiceBaseUrl string
param modelServiceAudience string
param modelDeploymentId string = 'claimguard-claim-fraud-baseline:1.0.0'
param approvedModelDeploymentIds string = modelDeploymentId
param prospectiveModelId string = 'claimguard-claim-fraud-baseline'
param prospectiveModelVersion string = '1.0.0'
param prospectiveFeatureSchemaVersion string = 'claim-feature-schema-2026.2'
param prospectiveAnalysisMode string = 'PROSPECTIVE_CLAIM_SCREENING'
param prospectiveThreshold string = '0.08760971001434723'
param ensembleModelServiceBaseUrl string
param ensembleModelServiceAudience string = modelServiceAudience
param ensembleDeploymentId string = 'claimguard-claim-fraud-ensemble:2.1.1'
param ensembleRuntimeConfigKey string = 'CLAIMGUARD_CLAIM_FRAUD_ENSEMBLE_2_1_1_E0652D762C0E'
param ensembleModelId string = 'claimguard-claim-fraud-ensemble'
param ensembleModelVersion string = '2.1.1'
param ensembleFeatureSchemaVersion string = 'claim-feature-schema-2026.2'
param ensembleAnalysisMode string = 'PROSPECTIVE_CLAIM_SCREENING'
param ensembleThreshold string = '0.049236234887246655'
param pollingIntervalSeconds int = 5
param maximumExecutions int = 1

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerAppsEnvironmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: workerIdentityName
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource controlPlaneSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: controlPlaneSecretName
}

resource operationalSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: operationalSecretName
}

resource pseudonymSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: modelPseudonymSecretName
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource claimScoringQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: claimScoringQueueName
  properties: {
    metadata: {
      component: 'claim-scoring'
      payload: 'outbox-reference-only'
    }
  }
}

var workerSecrets = [
  {
    name: 'control-plane-url'
    keyVaultUrl: '${vault.properties.vaultUri}secrets/${controlPlaneSecretName}'
    identity: identity.id
  }
  {
    name: 'operational-url'
    keyVaultUrl: '${vault.properties.vaultUri}secrets/${operationalSecretName}'
    identity: identity.id
  }
  {
    name: 'model-pseudonymization-key'
    keyVaultUrl: '${vault.properties.vaultUri}secrets/${modelPseudonymSecretName}'
    identity: identity.id
  }
]

var workerEnvironment = [
  { name: 'CONTROL_PLANE_MYSQL_URL', secretRef: 'control-plane-url' }
  { name: 'MYSQL_URL', secretRef: 'operational-url' }
  { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
  { name: 'CLAIM_SCORING_QUEUE_URL', value: 'https://${storage.name}.queue.core.windows.net/${claimScoringQueue.name}' }
  { name: 'MODEL_SERVICE_BASE_URL', value: modelServiceBaseUrl }
  { name: 'MODEL_SERVICE_AUDIENCE', value: modelServiceAudience }
  { name: 'MODEL_SERVICE_PSEUDONYMIZATION_KEY', secretRef: 'model-pseudonymization-key' }
  { name: 'MODEL_SERVICE_DEPLOYMENT_ID', value: modelDeploymentId }
  { name: 'MODEL_SERVICE_APPROVED_DEPLOYMENT_IDS', value: approvedModelDeploymentIds }
  { name: 'MODEL_SERVICE_EXPECTED_MODEL_ID', value: prospectiveModelId }
  { name: 'MODEL_SERVICE_EXPECTED_MODEL_VERSION', value: prospectiveModelVersion }
  { name: 'MODEL_SERVICE_EXPECTED_FEATURE_SCHEMA_VERSION', value: prospectiveFeatureSchemaVersion }
  { name: 'MODEL_SERVICE_EXPECTED_ANALYSIS_MODE', value: prospectiveAnalysisMode }
  { name: 'MODEL_SERVICE_EXPECTED_THRESHOLD', value: prospectiveThreshold }
  { name: 'MODEL_SERVICE_ENDPOINT_PATH', value: '/v3/claim-screening' }
  { name: 'MODEL_SERVICE_TIMEOUT_SECONDS', value: '120' }
  { name: 'MODEL_SERVICE_BASE_URL_${ensembleRuntimeConfigKey}', value: ensembleModelServiceBaseUrl }
  { name: 'MODEL_SERVICE_AUDIENCE_${ensembleRuntimeConfigKey}', value: ensembleModelServiceAudience }
  { name: 'MODEL_SERVICE_PSEUDONYMIZATION_KEY_${ensembleRuntimeConfigKey}', secretRef: 'model-pseudonymization-key' }
  { name: 'MODEL_SERVICE_EXPECTED_MODEL_ID_${ensembleRuntimeConfigKey}', value: ensembleModelId }
  { name: 'MODEL_SERVICE_EXPECTED_MODEL_VERSION_${ensembleRuntimeConfigKey}', value: ensembleModelVersion }
  { name: 'MODEL_SERVICE_EXPECTED_FEATURE_SCHEMA_VERSION_${ensembleRuntimeConfigKey}', value: ensembleFeatureSchemaVersion }
  { name: 'MODEL_SERVICE_EXPECTED_ANALYSIS_MODE_${ensembleRuntimeConfigKey}', value: ensembleAnalysisMode }
  { name: 'MODEL_SERVICE_EXPECTED_THRESHOLD_${ensembleRuntimeConfigKey}', value: ensembleThreshold }
  { name: 'MODEL_SERVICE_ENDPOINT_PATH_${ensembleRuntimeConfigKey}', value: '/v3/claim-screening' }
  { name: 'MODEL_SERVICE_TIMEOUT_SECONDS_${ensembleRuntimeConfigKey}', value: '120' }
  { name: 'REPORT_STORAGE_BACKEND', value: 'azure_blob' }
  { name: 'REPORT_STORAGE_ACCOUNT_URL', value: reportStorageAccountUrl }
  { name: 'REPORT_STORAGE_CONTAINER', value: reportStorageContainerName }
  { name: 'DATA_PLANE_ENVIRONMENT', value: 'legacy' }
  { name: 'DATA_PLANE_PRIVATE_ENVIRONMENT', value: 'production' }
  { name: 'DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS', value: '14' }
  { name: 'REPORT_WORKER_BATCH_SIZE', value: '10' }
  { name: 'REPORT_WORKER_MAX_BATCHES_PER_RUN', value: '100' }
  { name: 'REPORT_WORKER_LEASE_SECONDS', value: '300' }
  { name: 'REPORT_WORKER_MAX_ATTEMPTS', value: '5' }
  { name: 'REPORT_WORKER_RETRY_INITIAL_SECONDS', value: '30' }
  { name: 'REPORT_WORKER_RETRY_MAX_SECONDS', value: '900' }
]

var registryConfiguration = [
  {
    server: registry.properties.loginServer
    identity: identity.id
  }
]

resource reportWorker 'Microsoft.App/jobs@2024-03-01' = {
  name: reportWorkerJobName
  location: location
  tags: {
    component: 'report-producer'
    trigger: 'claim-scoring-queue'
    scaleToZero: 'true'
    schemaVersion: '14'
    stagedModelDeployment: ensembleDeploymentId
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Event'
      eventTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
        scale: {
          minExecutions: 0
          maxExecutions: maximumExecutions
          pollingInterval: pollingIntervalSeconds
          rules: [
            {
              name: 'claim-scoring-queue'
              type: 'azure-queue'
              identity: identity.id
              metadata: {
                accountName: storage.name
                queueName: claimScoringQueue.name
                queueLength: '1'
              }
            }
          ]
        }
      }
      replicaTimeout: 1800
      replicaRetryLimit: 2
      registries: registryConfiguration
      secrets: workerSecrets
    }
    template: {
      containers: [
        {
          name: 'report-producer'
          image: reportWorkerImage
          command: [
            'python'
            '-m'
            'claimguard_report_producer.cli'
          ]
          args: [
            'worker'
            'event'
          ]
          env: workerEnvironment
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    claimScoringQueue
  ]
}

resource recoveryWorker 'Microsoft.App/jobs@2024-03-01' = {
  name: recoveryJobName
  location: location
  tags: {
    component: 'report-producer-recovery'
    trigger: 'scheduled-outbox-recovery'
    scaleToZero: 'true'
    schemaVersion: '14'
    stagedModelDeployment: ensembleDeploymentId
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: recoveryScheduleCron
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 1800
      replicaRetryLimit: 1
      registries: registryConfiguration
      secrets: workerSecrets
    }
    template: {
      containers: [
        {
          name: 'report-producer-recovery'
          image: reportWorkerImage
          command: [
            'python'
            '-m'
            'claimguard_report_producer.cli'
          ]
          args: [
            'worker'
            'drain-all'
          ]
          env: workerEnvironment
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
    }
  }
}

output claimScoringQueueUrl string = 'https://${storage.name}.queue.core.windows.net/${claimScoringQueue.name}'
output reportWorkerJobId string = reportWorker.id
output recoveryWorkerJobId string = recoveryWorker.id
output workerIdentityClientId string = identity.properties.clientId
