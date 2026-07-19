targetScope = 'resourceGroup'

@description('Azure region used by the report-worker managed identity.')
param location string = resourceGroup().location

@description('Name of the dedicated report-worker user-assigned managed identity.')
param workerIdentityName string

@description('Name of the existing Azure Container Registry.')
param containerRegistryName string

@description('Name of the existing Key Vault.')
param keyVaultName string

@description('Name of the existing control-plane database connection secret.')
param controlPlaneSecretName string

@description('Name of the existing operational database connection secret.')
param operationalSecretName string

@description('Exact private-route Key Vault secret names for the one organisation assigned to this worker. Leave empty until an organisation is selected.')
param reportWorkerPrivateSecretNames array = []

@description('Name of the existing report storage account.')
param reportStorageAccountName string

@description('Name of the existing private report blob container.')
param reportStorageContainerName string

@description('Object ID of the GitHub Actions OIDC service principal.')
param githubActionsPrincipalId string

var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var storageBlobDataContributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

resource reportWorkerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: workerIdentityName
  location: location
  tags: {
    component: 'report-producer'
    managedBy: 'bicep'
    workload: 'claims-processing'
  }
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
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

resource reportWorkerPrivateSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [for secretName in reportWorkerPrivateSecretNames: {
  parent: keyVault
  name: secretName
}]

resource reportStorageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: reportStorageAccountName
}

resource reportBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: reportStorageAccount
  name: 'default'
}

resource reportStorageContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = {
  parent: reportBlobService
  name: reportStorageContainerName
}

resource reportWorkerAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, reportWorkerIdentity.id, acrPullRoleDefinitionId)
  scope: containerRegistry
  properties: {
    description: 'Allow the ClaimGuard report worker to pull immutable images.'
    principalId: reportWorkerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource reportWorkerControlPlaneSecretRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(controlPlaneSecret.id, reportWorkerIdentity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: controlPlaneSecret
  properties: {
    description: 'Allow the ClaimGuard report worker to resolve its approved data-plane route.'
    principalId: reportWorkerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
  }
}

resource reportWorkerOperationalSecretRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(operationalSecret.id, reportWorkerIdentity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: operationalSecret
  properties: {
    description: 'Allow the ClaimGuard report worker to drain the operational durable outbox.'
    principalId: reportWorkerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
  }
}

resource reportWorkerPrivateSecretReads 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (_, index) in reportWorkerPrivateSecretNames: {
  name: guid(reportWorkerPrivateSecrets[index].id, reportWorkerIdentity.id, keyVaultSecretsUserRoleDefinitionId)
  scope: reportWorkerPrivateSecrets[index]
  properties: {
    description: 'Allow the ClaimGuard report worker to resolve one approved private data-plane route.'
    principalId: reportWorkerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
  }
}]

resource reportWorkerBlobWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(reportStorageContainer.id, reportWorkerIdentity.id, storageBlobDataContributorRoleDefinitionId)
  scope: reportStorageContainer
  properties: {
    description: 'Allow the ClaimGuard report worker to publish only to the report container.'
    principalId: reportWorkerIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobDataContributorRoleDefinitionId
  }
}

resource githubActionsControlPlaneSecretRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(controlPlaneSecret.id, githubActionsPrincipalId, keyVaultSecretsUserRoleDefinitionId)
  scope: controlPlaneSecret
  properties: {
    description: 'Allow the ClaimGuard GitHub deployment identity to run control-plane migrations.'
    principalId: githubActionsPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
  }
}

output workerIdentityId string = reportWorkerIdentity.id
output workerIdentityClientId string = reportWorkerIdentity.properties.clientId
output workerIdentityPrincipalId string = reportWorkerIdentity.properties.principalId
output privateSecretRoleCount int = length(reportWorkerPrivateSecretReads)
