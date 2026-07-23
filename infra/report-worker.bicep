targetScope = 'resourceGroup'

@description('Azure region of the existing Container Apps environment.')
param location string = resourceGroup().location

@description('Name of the existing Container Apps environment.')
param containerAppsEnvironmentName string

@description('Name of the existing Azure Container Registry.')
param containerRegistryName string

@description('Name of the existing report-worker user-assigned managed identity.')
param workerIdentityName string

@description('Name of the existing Key Vault.')
param keyVaultName string

@description('Name of the existing control-plane database connection secret.')
param controlPlaneSecretName string

@description('Name of the existing operational database connection secret.')
param operationalSecretName string

@description('Name of the Key Vault secret used to pseudonymize identifiers sent to the model.')
param modelPseudonymSecretName string

@secure()
@description('At least 32 bytes of random key material for deterministic model pseudonyms.')
param modelPseudonymizationKey string

@description('Immutable report-worker image reference, preferably an ACR digest.')
param reportWorkerImage string

@description('HTTPS origin of the infrastructure-owned model service.')
param modelServiceBaseUrl string

@description('Microsoft Entra application audience exposed by the model service.')
param modelServiceAudience string

@description('Approved immutable model deployment identifier.')
param modelDeploymentId string = 'claimguard-claim-fraud-ensemble:1.1.0'

@description('Azure Storage account URL used for report publication.')
param reportStorageAccountUrl string

@description('Private blob container used for report publication.')
param reportStorageContainerName string = 'claimguard-reports'

@description('Name of the scheduled report-producer job.')
param reportWorkerJobName string = 'claimguard-report-producer'

var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerAppsEnvironmentName
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: workerIdentityName
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource controlPlaneSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: keyVault
  name: controlPlaneSecretName
}

resource operationalSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: keyVault
  name: operationalSecretName
}

resource modelPseudonymSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: modelPseudonymSecretName
  properties: {
    value: modelPseudonymizationKey
    contentType: 'application/vnd.claimguard.model-pseudonymization-key'
    attributes: {
      enabled: true
    }
  }
  tags: {
    component: 'report-producer'
    managedBy: 'bicep'
    purpose: 'model-pseudonymization'
  }
}

resource workerAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, workerIdentity.id, acrPullRoleDefinitionId)
  scope: containerRegistry
  properties: {
    description: 'Allow the report worker to pull its immutable image.'
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource workerModelPseudonymSecretRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(modelPseudonymSecret.id, workerIdentity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: modelPseudonymSecret
  properties: {
    description: 'Allow the report worker to resolve only its model-pseudonymization key.'
    principalId: workerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
  }
}

resource reportWorkerJob 'Microsoft.App/jobs@2024-03-01' = {
  name: reportWorkerJobName
  location: location
  tags: {
    component: 'report-producer'
    managedBy: 'bicep'
    modelDeploymentId: modelDeploymentId
    schemaVersion: '13'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${workerIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: '*/5 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 1800
      replicaRetryLimit: 0
      registries: [
        {
          server: containerRegistry.properties.loginServer
          identity: workerIdentity.id
        }
      ]
      secrets: [
        {
          name: 'control-plane-url'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${controlPlaneSecretName}'
          identity: workerIdentity.id
        }
        {
          name: 'operational-url'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${operationalSecretName}'
          identity: workerIdentity.id
        }
        {
          name: 'model-pseudonymization-key'
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${modelPseudonymSecretName}'
          identity: workerIdentity.id
        }
      ]
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
            'drain-all'
          ]
          env: [
            {
              name: 'CONTROL_PLANE_MYSQL_URL'
              secretRef: 'control-plane-url'
            }
            {
              name: 'MYSQL_URL'
              secretRef: 'operational-url'
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: workerIdentity.properties.clientId
            }
            {
              name: 'MODEL_SERVICE_BASE_URL'
              value: modelServiceBaseUrl
            }
            {
              name: 'MODEL_SERVICE_AUDIENCE'
              value: modelServiceAudience
            }
            {
              name: 'MODEL_SERVICE_PSEUDONYMIZATION_KEY'
              secretRef: 'model-pseudonymization-key'
            }
            {
              name: 'MODEL_SERVICE_DEPLOYMENT_ID'
              value: modelDeploymentId
            }
            {
              name: 'MODEL_SERVICE_EXPECTED_ENSEMBLE_ID'
              value: 'claimguard-claim-fraud-ensemble'
            }
            {
              name: 'MODEL_SERVICE_EXPECTED_ENSEMBLE_VERSION'
              value: '1.1.0'
            }
            {
              name: 'MODEL_SERVICE_EXPECTED_FEATURE_SCHEMA_VERSION'
              value: 'claim-feature-schema-2026.2'
            }
            {
              name: 'MODEL_SERVICE_EXPECTED_BASELINE_THRESHOLD'
              value: '0.08760971001434723'
            }
            {
              name: 'MODEL_SERVICE_EXPECTED_RING_THRESHOLD'
              value: '0.148'
            }
            {
              name: 'MODEL_SERVICE_EXPECTED_PHANTOM_THRESHOLD'
              value: '0.8138303120761656'
            }
            {
              name: 'MODEL_SERVICE_TIMEOUT_SECONDS'
              value: '120'
            }
            {
              name: 'REPORT_STORAGE_BACKEND'
              value: 'azure_blob'
            }
            {
              name: 'REPORT_STORAGE_ACCOUNT_URL'
              value: reportStorageAccountUrl
            }
            {
              name: 'REPORT_STORAGE_CONTAINER'
              value: reportStorageContainerName
            }
            {
              name: 'DATA_PLANE_ENVIRONMENT'
              value: 'legacy'
            }
            {
              name: 'DATA_PLANE_PRIVATE_ENVIRONMENT'
              value: 'production'
            }
            {
              name: 'DATA_PLANE_SUPPORTED_SCHEMA_VERSIONS'
              value: '13'
            }
            {
              name: 'REPORT_WORKER_BATCH_SIZE'
              value: '10'
            }
            {
              name: 'REPORT_WORKER_MAX_BATCHES_PER_RUN'
              value: '100'
            }
            {
              name: 'REPORT_WORKER_LEASE_SECONDS'
              value: '300'
            }
            {
              name: 'REPORT_WORKER_MAX_ATTEMPTS'
              value: '5'
            }
            {
              name: 'REPORT_WORKER_RETRY_INITIAL_SECONDS'
              value: '30'
            }
            {
              name: 'REPORT_WORKER_RETRY_MAX_SECONDS'
              value: '900'
            }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    controlPlaneSecret
    operationalSecret
    workerAcrPull
    workerModelPseudonymSecretRead
  ]
}

output reportWorkerJobId string = reportWorkerJob.id
output reportWorkerIdentityClientId string = workerIdentity.properties.clientId
output modelDeploymentId string = modelDeploymentId
