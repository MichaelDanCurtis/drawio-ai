param password string
param subnetId string
param keyVaultName string

resource sql 'Microsoft.Sql/servers@2023-05-01-preview' = {
  name: 'sql-app'
  location: resourceGroup().location
  properties: {
    administratorLogin: 'sqladmin'
    administratorLoginPassword: password
    publicNetworkAccess: 'Enabled'
  }
}

resource sqlDb 'Microsoft.Sql/servers/databases@2023-05-01-preview' = {
  parent: sql
  name: 'appdb'
  location: resourceGroup().location
}
