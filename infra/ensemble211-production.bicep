targetScope = 'resourceGroup'

param location string = resourceGroup().location
param containerAppsEnvironmentName string = 'claimguard-env-11e'
param containerRegistryName string = 'claimguardacr11e'
param modelIdentityName string = 'claimguard-prospective-model-identity'
param modelContainerAppName string = 'claimguard-ml-ensemble-211'
param modelImage string
param tenantId string
param modelAuthClientId string
param workerPrincipalId string

@secure()
param modelAuthClientSecret string

var authSecretName = 'microsoft-provider-authentication-secret'
var deploymentId = 'claimguard-claim-fraud-ensemble:2.1.1'
var modelAudience = 'api://${modelAuthClientId}'

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerAppsEnvironmentName
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

resource modelIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: modelIdentityName
}

resource modelContainerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: modelContainerAppName
  location: location
  tags: {
    component: 'prospective-model-service'
    deploymentId: deploymentId
    managedBy: 'bicep'
    trafficMode: 'prospective-on-demand'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${modelIdentity.id}': {}
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
          identity: modelIdentity.id
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
              value: modelIdentity.properties.clientId
            }
            {
              name: 'CLAIMGUARD_MODEL_AUTH_MODE'
              value: 'entra_proxy'
            }
            {
              name: 'CLAIMGUARD_ALLOWED_CALLER_PRINCIPAL_ID'
              value: workerPrincipalId
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
        maxReplicas: 2
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
}

resource modelAuth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: modelContainerApp
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

output modelContainerAppId string = modelContainerApp.id
output modelAudience string = modelAudience
output modelBaseUrl string = 'https://${modelContainerApp.properties.configuration.ingress.fqdn}'
