// App on Azure (made up for tests)
param location string = resourceGroup().location
@secure()
param sqlPassword string

var prefix = 'app'

resource stg 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: '${prefix}stg'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: true
    minimumTlsVersion: 'TLS1_2'
  }
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-04-01' = {
  name: 'nsg-web'
  location: location
  properties: {
    securityRules: [
      {
        name: 'rdp'
        properties: { sourceAddressPrefix: '*', destinationPortRange: '3389', access: 'Allow', direction: 'Inbound', priority: 100, protocol: 'Tcp', sourcePortRange: '*', destinationAddressPrefix: '*' }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-04-01' = {
  name: 'vnet-app'
  location: location
  properties: {
    addressSpace: { addressPrefixes: [ '10.30.0.0/16' ] }
  }

  resource appSubnet 'subnets' = {
    name: 'snet-app'
    properties: {
      addressPrefix: '10.30.1.0/24'
      networkSecurityGroup: { id: nsg.id }
    }
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: 'plan-app'
  location: location
  sku: { name: 'P1v3' }
}

resource site 'Microsoft.Web/sites@2023-01-01' = {
  name: 'web-${prefix}'
  location: location
  kind: 'app'
  properties: {
    serverFarmId: plan.id
    httpsOnly: false
    virtualNetworkSubnetId: vnet::appSubnet.id
    siteConfig: {
      appSettings: [
        { name: 'STORAGE', value: 'DefaultEndpointsProtocol=https;AccountName=${stg.name}' }
      ]
    }
  }
}

resource kv 'Microsoft.KeyVault/vaults@2023-02-01' existing = {
  name: 'kv-shared'
}

resource workers 'Microsoft.Web/sites@2023-01-01' = [for i in range(0, 2): {
  name: 'worker-${i}'
  location: location
  kind: 'functionapp'
  properties: { serverFarmId: plan.id }
}]

module db 'modules/db.bicep' = {
  name: 'db'
  params: {
    password: sqlPassword
    subnetId: vnet::appSubnet.id
    keyVaultName: kv.name
  }
}

module shared 'br/public:avm/res/network/private-dns-zone:0.2.0' = {
  name: 'dns'
}
