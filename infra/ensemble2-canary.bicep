targetScope = 'resourceGroup'

@description('Azure region of the existing Container Apps environment.')
param location string = resourceGroup().location

@description('Name of the existing Container Apps environment.')
param containerAppsEnvironmentName string = 'claimguard-env-11e'

@description('Name of the existing Azure Container Registry.')
param containerRegistryName string = 'claimguardacr11e'

@description('Name of the isolated Ensemble 2.1.1 canary identity.')
param canaryIdentityName string = 'claimguard-ensemble-211-canary-identity'

@description('Name of the isolated Ensemble 2.1.1 canary Container App.')
param canaryContainerAppName string = 'claimguard-ensemble-211-canary'

@description('Immutable Ensemble 2.1.1 image reference.')
param modelImage string

@description('Microsoft Entra tenant ID.')
param tenantId string

@description('Client ID of the existing single-tenant model-service app registration.')
param modelAuthClientId string

@secure()
@description('Client secret used only by Container Apps built-in authentication.')
param modelAuthClientSecret string

var acrPullRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var authSecretName = 'microsoft-provider-authentication-secret'
var deploymentId = 'claimguard-claim-fraud-ensemble:2.1.1'
var modelAudience = 'api://${modelAuthClientId}'

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerAppsEnvironmentName
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource canaryIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: canaryIdentityName
  location: location
  tags: {
    component: 'model-release-canary'
    deploymentId: deploymentId
    managedBy: 'bicep'
    productionTraffic: 'disabled'
  }
}

resource canaryAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, canaryIdentity.id, acrPullRoleDefinitionId)
  scope: containerRegistry
  properties: {
    description: 'Allow only the isolated Ensemble 2.1.1 canary to pull from ClaimGuard ACR.'
    principalId: canaryIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleDefinitionId
  }
}

resource canaryContainerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: canaryContainerAppName
  location: location
  tags: {
    component: 'model-release-canary'
    deploymentId: deploymentId
    managedBy: 'bicep'
    productionTraffic: 'disabled'
    tenantScope: 'none'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${canaryIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerAppsEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8000
        transport: 'http'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: containerRegistry.properties.loginServer
          identity: canaryIdentity.id
        }
      ]
      secrets: [
        {
          name: authSecretName
          value: modelAuthClientSecret
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'model-service'
          image: modelImage
          env: [
            {
              name: 'AZURE_CLIENT_ID'
              value: canaryIdentity.properties.clientId
            }
            {
              name: 'CLAIMGUARD_MODEL_AUTH_MODE'
              value: 'entra_proxy'
            }
            {
              name: 'CLAIMGUARD_ALLOWED_CALLER_PRINCIPAL_ID'
              value: canaryIdentity.properties.principalId
            }
            {
              name: 'CLAIMGUARD_BASELINE_PATH'
              value: '/opt/claimguard/model'
            }
            {
              name: 'CLAIMGUARD_MODEL_DEPLOYMENT_ID'
              value: deploymentId
            }
          ]
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health/ready'
                port: 8000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 30
              successThreshold: 1
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 8000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 6
              successThreshold: 1
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 8000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 30
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
              successThreshold: 1
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '1'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    canaryAcrPull
  ]
}

resource canaryAuth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: canaryContainerApp
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'Return401'
      excludedPaths: [
        '/health/live'
        '/health/ready'
      ]
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: modelAuthClientId
          clientSecretSettingName: authSecretName
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            modelAudience
          ]
        }
      }
    }
    login: {
      tokenStore: {
        enabled: false
      }
    }
    httpSettings: {
      requireHttps: true
    }
  }
}

output canaryContainerAppId string = canaryContainerApp.id
output canaryIdentityClientId string = canaryIdentity.properties.clientId
output canaryIdentityPrincipalId string = canaryIdentity.properties.principalId
output canaryAudience string = modelAudience
output canaryBaseUrl string = 'https://${canaryContainerApp.properties.configuration.ingress.fqdn}'
