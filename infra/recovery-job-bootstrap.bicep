targetScope = 'resourceGroup'

param location string = resourceGroup().location
param containerAppsEnvironmentName string
param workerIdentityName string
param recoveryJobName string = 'claimguard-report-recovery'
param bootstrapImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: containerAppsEnvironmentName
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: workerIdentityName
}

resource recoveryWorkerBootstrap 'Microsoft.App/jobs@2024-03-01' = {
  name: recoveryJobName
  location: location
  tags: {
    component: 'report-producer-recovery'
    safetyState: 'manual-identity-bootstrap'
    schemaVersion: '14'
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
      triggerType: 'Manual'
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 300
      replicaRetryLimit: 0
    }
    template: {
      containers: [
        {
          name: 'recovery-bootstrap'
          image: bootstrapImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}

output recoveryWorkerBootstrapId string = recoveryWorkerBootstrap.id
output workerIdentityId string = identity.id
