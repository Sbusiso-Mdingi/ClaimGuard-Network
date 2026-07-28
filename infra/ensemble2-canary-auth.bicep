targetScope = 'resourceGroup'

@description('Name of the existing isolated Ensemble 2.1.1 canary Container App.')
param canaryContainerAppName string = 'claimguard-ensemble-211-canary'

@description('Microsoft Entra tenant ID.')
param tenantId string

@description('Client ID of the existing single-tenant model-service app registration.')
param modelAuthClientId string

var authSecretName = 'microsoft-provider-authentication-secret'
var modelAudience = 'api://${modelAuthClientId}'

resource canaryContainerApp 'Microsoft.App/containerApps@2024-03-01' existing = {
  name: canaryContainerAppName
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

output canaryAuthConfigId string = canaryAuth.id
