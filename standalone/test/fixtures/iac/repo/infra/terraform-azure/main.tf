resource "azurerm_resource_group" "rg" {
  name     = "rg-app"
  location = "westeurope"
}

resource "azurerm_virtual_network" "vnet" {
  name                = "vnet-app"
  address_space       = ["10.20.0.0/16"]
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

resource "azurerm_subnet" "app" {
  name                 = "snet-app"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.20.1.0/24"]
}

resource "azurerm_storage_account" "sa" {
  name                            = "stexampleapp"
  resource_group_name             = azurerm_resource_group.rg.name
  location                        = azurerm_resource_group.rg.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  allow_nested_items_to_be_public = true
  min_tls_version                 = "TLS1_0"
}

resource "azurerm_linux_function_app" "fn" {
  name                       = "func-app"
  resource_group_name        = azurerm_resource_group.rg.name
  location                   = azurerm_resource_group.rg.location
  storage_account_name       = azurerm_storage_account.sa.name
  virtual_network_subnet_id  = azurerm_subnet.app.id
}

resource "azurerm_key_vault" "kv" {
  name                = "kv-app"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tenant_id           = "00000000-0000-0000-0000-000000000000"
  sku_name            = "standard"
}

resource "azurerm_mssql_firewall_rule" "everyone" {
  name             = "allow-everyone"
  server_id        = var.sql_server_id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "255.255.255.255"
}

# HTTPS from the internet is what a web tier is for: not a finding.
resource "azurerm_network_security_group" "web" {
  name                = "nsg-web"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  security_rule {
    name                       = "https"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "Internet"
    destination_address_prefix = "*"
  }
}
