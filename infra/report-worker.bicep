targetScope = 'resourceGroup'

@description('Azure region of the existing Container Apps environment.')
param location string = resourceGroup().location

@description('Name of the existing Container Apps environment.')
param containerAppsEnvironmentName string

@description('Name of the existing Azure Container Registry.')
param container