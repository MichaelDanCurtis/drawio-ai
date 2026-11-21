/**
 * Azure resource types → draw.io's Azure icons (img/lib/azure2/**, the same files
 * the "Azure" shape library uses) and the styles of the group boxes.
 * Every path here is checked against the bundled draw.io in the tests.
 */

const ICONS: Record<string, string> = {
	// Compute
	"microsoft.compute/virtualmachines": "compute/Virtual_Machine.svg",
	"microsoft.compute/virtualmachinescalesets": "compute/VM_Scale_Sets.svg",
	"microsoft.compute/disks": "compute/Disks.svg",
	"microsoft.compute/snapshots": "compute/Disks_Snapshots.svg",
	"microsoft.compute/availabilitysets": "compute/Availability_Sets.svg",
	"microsoft.compute/images": "compute/Images.svg",
	"microsoft.compute/galleries": "compute/Azure_Compute_Galleries.svg",
	"microsoft.compute/diskencryptionsets": "compute/Disk_Encryption_Sets.svg",
	"microsoft.compute/hostgroups": "compute/Host_Groups.svg",
	"microsoft.compute/sshpublickeys": "other/SSH_Keys.svg",
	"microsoft.compute/restorepointcollections": "compute/Restore_Points_Collections.svg",
	"microsoft.compute/proximityplacementgroups": "networking/Proximity_Placement_Groups.svg",
	"microsoft.batch/batchaccounts": "compute/Batch_Accounts.svg",
	"microsoft.servicefabric/clusters": "compute/Service_Fabric_Clusters.svg",
	"microsoft.desktopvirtualization/hostpools": "compute/Host_Pools.svg",
	"microsoft.desktopvirtualization/applicationgroups": "compute/Application_Group.svg",
	"microsoft.desktopvirtualization/workspaces": "compute/Workspaces.svg",
	"microsoft.avs/privateclouds": "azure_vmware_solution/AVS.svg",
	"microsoft.hybridcompute/machines": "management_governance/Arc_Machines.svg",
	// Containers
	"microsoft.containerservice/managedclusters": "containers/Kubernetes_Services.svg",
	"microsoft.containerservice/fleets": "other/Kubernetes_Fleet_Manager.svg",
	"microsoft.kubernetes/connectedclusters": "other/Arc_Kubernetes.svg",
	"microsoft.containerregistry/registries": "containers/Container_Registries.svg",
	"microsoft.containerinstance/containergroups": "containers/Container_Instances.svg",
	"microsoft.app/managedenvironments": "other/Container_App_Environments.svg",
	"microsoft.app/containerapps": "other/Worker_Container_App.svg",
	"microsoft.app/jobs": "other/Worker_Container_App.svg",
	"microsoft.redhatopenshift/openshiftclusters": "containers/Azure_Red_Hat_OpenShift.svg",
	// App Service, integration
	"microsoft.web/sites": "app_services/App_Services.svg",
	"microsoft.web/sites/slots": "app_services/App_Services.svg",
	"microsoft.web/serverfarms": "app_services/App_Service_Plans.svg",
	"microsoft.web/staticsites": "app_services/App_Services.svg",
	"microsoft.web/hostingenvironments": "app_services/App_Service_Environments.svg",
	"microsoft.web/certificates": "app_services/App_Service_Certificates.svg",
	"microsoft.web/connections": "devops/API_Connections.svg",
	"microsoft.logic/workflows": "integration/Logic_Apps.svg",
	"microsoft.logic/integrationaccounts": "integration/Integration_Accounts.svg",
	"microsoft.apimanagement/service": "app_services/API_Management_Services.svg",
	"microsoft.servicebus/namespaces": "integration/Service_Bus.svg",
	"microsoft.eventhub/namespaces": "analytics/Event_Hubs.svg",
	"microsoft.eventhub/clusters": "analytics/Event_Hub_Clusters.svg",
	"microsoft.eventgrid/topics": "integration/Event_Grid_Topics.svg",
	"microsoft.eventgrid/systemtopics": "integration/System_Topic.svg",
	"microsoft.eventgrid/domains": "integration/Event_Grid_Domains.svg",
	"microsoft.eventgrid/partnertopics": "integration/Partner_Topic.svg",
	"microsoft.appconfiguration/configurationstores": "integration/App_Configuration.svg",
	"microsoft.signalrservice/signalr": "web/SignalR.svg",
	"microsoft.signalrservice/webpubsub": "integration/Azure_PubSub.svg",
	"microsoft.relay/namespaces": "integration/Relays.svg",
	"microsoft.notificationhubs/namespaces": "web/Notification_Hub_Namespaces.svg",
	"microsoft.search/searchservices": "app_services/Search_Services.svg",
	"microsoft.communication/communicationservices": "other/Azure_Communication_Services.svg",
	// Networking
	"microsoft.network/virtualnetworks": "networking/Virtual_Networks.svg",
	"microsoft.network/networkinterfaces": "networking/Network_Interfaces.svg",
	"microsoft.network/publicipaddresses": "networking/Public_IP_Addresses.svg",
	"microsoft.network/publicipprefixes": "networking/Public_IP_Prefixes.svg",
	"microsoft.network/networksecuritygroups": "networking/Network_Security_Groups.svg",
	"microsoft.network/applicationsecuritygroups": "security/Application_Security_Groups.svg",
	"microsoft.network/routetables": "networking/Route_Tables.svg",
	"microsoft.network/natgateways": "networking/NAT.svg",
	"microsoft.network/loadbalancers": "networking/Load_Balancers.svg",
	"microsoft.network/applicationgateways": "networking/Application_Gateways.svg",
	"microsoft.network/applicationgatewaywebapplicationfirewallpolicies": "networking/Web_Application_Firewall_Policies_WAF.svg",
	"microsoft.network/frontdoorwebapplicationfirewallpolicies": "networking/Web_Application_Firewall_Policies_WAF.svg",
	"microsoft.network/frontdoors": "networking/Front_Doors.svg",
	"microsoft.cdn/profiles": "networking/CDN_Profiles.svg",
	"microsoft.network/azurefirewalls": "networking/Firewalls.svg",
	"microsoft.network/firewallpolicies": "networking/Azure_Firewall_Policy.svg",
	"microsoft.network/bastionhosts": "networking/Bastions.svg",
	"microsoft.network/virtualnetworkgateways": "networking/Virtual_Network_Gateways.svg",
	"microsoft.network/localnetworkgateways": "networking/Local_Network_Gateways.svg",
	"microsoft.network/connections": "networking/Connections.svg",
	"microsoft.network/expressroutecircuits": "networking/ExpressRoute_Circuits.svg",
	"microsoft.network/privateendpoints": "networking/Private_Endpoint.svg",
	"microsoft.network/privatelinkservices": "networking/Private_Link_Service.svg",
	"microsoft.network/privatednszones": "networking/DNS_Zones.svg",
	"microsoft.network/dnszones": "networking/DNS_Zones.svg",
	"microsoft.network/dnsresolvers": "networking/DNS_Private_Resolver.svg",
	"microsoft.network/trafficmanagerprofiles": "networking/Traffic_Manager_Profiles.svg",
	"microsoft.network/networkwatchers": "networking/Network_Watcher.svg",
	"microsoft.network/ddosprotectionplans": "networking/DDoS_Protection_Plans.svg",
	"microsoft.network/virtualwans": "networking/Virtual_WANs.svg",
	"microsoft.network/virtualhubs": "networking/Virtual_WAN_Hub.svg",
	"microsoft.network/ipgroups": "networking/IP_Groups.svg",
	"microsoft.network/networkmanagers": "other/Azure_Network_Manager.svg",
	"microsoft.network/serviceendpointpolicies": "networking/Service_Endpoint_Policies.svg",
	// Databases, analytics
	"microsoft.sql/servers": "databases/SQL_Server.svg",
	"microsoft.sql/servers/databases": "databases/SQL_Database.svg",
	"microsoft.sql/servers/elasticpools": "databases/SQL_Elastic_Pools.svg",
	"microsoft.sql/managedinstances": "databases/SQL_Managed_Instance.svg",
	"microsoft.sql/managedinstances/databases": "databases/Managed_Database.svg",
	"microsoft.sqlvirtualmachine/sqlvirtualmachines": "databases/Azure_SQL_VM.svg",
	"microsoft.documentdb/databaseaccounts": "databases/Azure_Cosmos_DB.svg",
	"microsoft.dbforpostgresql/flexibleservers": "databases/Azure_Database_PostgreSQL_Server.svg",
	"microsoft.dbforpostgresql/servers": "databases/Azure_Database_PostgreSQL_Server.svg",
	"microsoft.dbformysql/flexibleservers": "databases/Azure_Database_MySQL_Server.svg",
	"microsoft.dbformysql/servers": "databases/Azure_Database_MySQL_Server.svg",
	"microsoft.dbformariadb/servers": "databases/Azure_Database_MariaDB_Server.svg",
	"microsoft.cache/redis": "databases/Cache_Redis.svg",
	"microsoft.cache/redisenterprise": "databases/Azure_Managed_Redis.svg",
	"microsoft.kusto/clusters": "databases/Azure_Data_Explorer_Clusters.svg",
	"microsoft.datafactory/factories": "databases/Data_Factory.svg",
	"microsoft.synapse/workspaces": "analytics/Azure_Synapse_Analytics.svg",
	"microsoft.databricks/workspaces": "analytics/Azure_Databricks.svg",
	"microsoft.purview/accounts": "databases/Azure_Purview_Accounts.svg",
	"microsoft.streamanalytics/streamingjobs": "analytics/Stream_Analytics_Jobs.svg",
	"microsoft.analysisservices/servers": "analytics/Analysis_Services.svg",
	"microsoft.powerbidedicated/capacities": "analytics/Power_BI_Embedded.svg",
	"microsoft.hdinsight/clusters": "analytics/HD_Insight_Clusters.svg",
	// Storage, backup
	"microsoft.storage/storageaccounts": "storage/Storage_Accounts.svg",
	"microsoft.recoveryservices/vaults": "storage/Recovery_Services_Vaults.svg",
	"microsoft.dataprotection/backupvaults": "other/Backup_Vault.svg",
	"microsoft.netapp/netappaccounts": "storage/Azure_NetApp_Files.svg",
	"microsoft.storagesync/storagesyncservices": "storage/Storage_Sync_Services.svg",
	"microsoft.elasticsan/elasticsans": "other/Elastic_SAN.svg",
	// Security, identity
	"microsoft.keyvault/vaults": "security/Key_Vaults.svg",
	"microsoft.keyvault/managedhsms": "other/Dedicated_HSM.svg",
	"microsoft.managedidentity/userassignedidentities": "identity/Managed_Identities.svg",
	"microsoft.attestation/attestationproviders": "other/AzureAttestation.svg",
	// Monitoring, management
	"microsoft.insights/components": "devops/Application_Insights.svg",
	"microsoft.operationalinsights/workspaces": "analytics/Log_Analytics_Workspaces.svg",
	"microsoft.operationsmanagement/solutions": "management_governance/Solutions.svg",
	"microsoft.insights/actiongroups": "management_governance/Alerts.svg",
	"microsoft.insights/metricalerts": "management_governance/Alerts.svg",
	"microsoft.insights/scheduledqueryrules": "management_governance/Alerts.svg",
	"microsoft.insights/activitylogalerts": "management_governance/Alerts.svg",
	"microsoft.alertsmanagement/smartdetectoralertrules": "management_governance/Alerts.svg",
	"microsoft.alertsmanagement/prometheusrulegroups": "other/Prometheus.svg",
	"microsoft.insights/datacollectionrules": "other/Data_Collection_Rules.svg",
	"microsoft.insights/datacollectionendpoints": "other/Data_Collection_Rules.svg",
	"microsoft.insights/workbooks": "analytics/Azure_Workbooks.svg",
	"microsoft.portal/dashboards": "general/Dashboard.svg",
	"microsoft.automation/automationaccounts": "management_governance/Automation_Accounts.svg",
	"microsoft.dashboard/grafana": "other/Grafana.svg",
	"microsoft.monitor/accounts": "other/Prometheus.svg",
	"microsoft.resources/templatespecs": "other/Template_Specs.svg",
	"microsoft.maintenance/maintenanceconfigurations": "compute/Maintenance_Configuration.svg",
	"microsoft.devtestlab/labs": "devops/DevTest_Labs.svg",
	"microsoft.loadtestservice/loadtests": "other/Azure_Load_Testing.svg",
	"microsoft.devcenter/devcenters": "other/MS_Dev_Box.svg",
	"microsoft.devopsinfrastructure/pools": "other/Managed_DevOps_Pools.svg",
	// AI, IoT
	"microsoft.cognitiveservices/accounts": "ai_machine_learning/Cognitive_Services.svg",
	"microsoft.machinelearningservices/workspaces": "ai_machine_learning/Machine_Learning.svg",
	"microsoft.botservice/botservices": "ai_machine_learning/Bot_Services.svg",
	"microsoft.devices/iothubs": "iot/IoT_Hub.svg",
	"microsoft.devices/provisioningservices": "iot/Device_Provisioning_Services.svg",
	"microsoft.digitaltwins/digitaltwinsinstances": "iot/Digital_Twins.svg",
	"microsoft.maps/accounts": "iot/Azure_Maps_Accounts.svg",
};

/** Icons that depend on the resource's kind (function apps are sites, Azure OpenAI is a Cognitive Services account...). */
function byKind(type: string, kind: string): string | undefined {
	const k = kind.toLowerCase();
	if (type === "microsoft.web/sites" || type === "microsoft.web/sites/slots") {
		if (k.includes("workflowapp")) return "integration/Logic_Apps.svg";
		if (k.includes("functionapp")) return "compute/Function_Apps.svg";
	}
	if (type === "microsoft.cognitiveservices/accounts") {
		if (k === "openai") return "ai_machine_learning/Azure_OpenAI.svg";
		if (k === "aiservices") return "ai_machine_learning/AI_Studio.svg";
		if (k === "formrecognizer") return "ai_machine_learning/Form_Recognizers.svg";
		if (k === "computervision") return "ai_machine_learning/Computer_Vision.svg";
		if (k === "speechservices") return "ai_machine_learning/Speech_Services.svg";
		if (k === "textanalytics") return "ai_machine_learning/Language_Services.svg";
	}
	if (type === "microsoft.machinelearningservices/workspaces" && (k === "hub" || k === "project")) return "ai_machine_learning/AI_Studio.svg";
	if (type === "microsoft.cdn/profiles" && k.includes("frontdoor")) return "networking/Front_Doors.svg";
	return undefined;
}

export const GENERIC_ICON = "general/All_Resources.svg";
export const SUBSCRIPTION_ICON = "general/Subscriptions.svg";
export const RESOURCE_GROUP_ICON = "general/Resource_Groups.svg";
export const VNET_ICON = "networking/Virtual_Networks.svg";
export const SUBNET_ICON = "networking/Subnet.svg";

/** The icon file (relative to img/lib/azure2/) for a resource, or undefined for unmapped types. */
export function azureIcon(type: string, kind?: string, sku?: string): string | undefined {
	const t = type.toLowerCase();
	return byKind(t, `${kind ?? ""}${t === "microsoft.cdn/profiles" ? ` ${sku ?? ""}` : ""}`) ?? ICONS[t];
}

/** All icon files the recipe may reference (for tests). */
export function allAzureIconFiles(): string[] {
	const fromKinds = [
		["microsoft.web/sites", "functionapp"],
		["microsoft.web/sites", "functionapp,workflowapp"],
		["microsoft.cognitiveservices/accounts", "openai"],
		["microsoft.cognitiveservices/accounts", "aiservices"],
		["microsoft.cognitiveservices/accounts", "formrecognizer"],
		["microsoft.cognitiveservices/accounts", "computervision"],
		["microsoft.cognitiveservices/accounts", "speechservices"],
		["microsoft.cognitiveservices/accounts", "textanalytics"],
		["microsoft.machinelearningservices/workspaces", "hub"],
		["microsoft.cdn/profiles", "frontdoor"],
	].map(([t, k]) => byKind(t, k)!);
	return [...new Set([...Object.values(ICONS), ...fromKinds, GENERIC_ICON, SUBSCRIPTION_ICON, RESOURCE_GROUP_ICON, VNET_ICON, SUBNET_ICON])];
}

export function mappedAzureTypes(): string[] {
	return Object.keys(ICONS);
}

export const ICON_STYLE = (file: string) => `image;aspect=fixed;html=1;points=[];align=center;fontSize=11;image=img/lib/azure2/${file};`;

/**
 * Group boxes: draw.io's "label" shape draws the Azure icon in the top-left corner,
 * the way Microsoft's reference architectures draw subscriptions, resource groups,
 * virtual networks and subnets.
 */
const GROUP =
	"shape=label;html=1;whiteSpace=wrap;container=1;collapsible=0;recursiveResize=0;rounded=1;arcSize=1;absoluteArcSize=1;verticalAlign=top;align=left;spacingTop=4;fontStyle=1;imageAlign=left;imageVerticalAlign=top;";
export const CONTAINER_STYLES = {
	subscription: `${GROUP}image=img/lib/azure2/${SUBSCRIPTION_ICON};imageWidth=16;imageHeight=26;spacingLeft=30;fontSize=13;fillColor=#FFFFFF;strokeColor=#0078D4;strokeWidth=2;`,
	resourceGroup: `${GROUP}image=img/lib/azure2/${RESOURCE_GROUP_ICON};imageWidth=22;imageHeight=21;spacingLeft=32;fontSize=12;fillColor=#F8F9FA;strokeColor=#7A7A7A;dashed=1;dashPattern=6 4;`,
	vnet: `${GROUP}image=img/lib/azure2/${VNET_ICON};imageWidth=24;imageHeight=14;spacingLeft=34;fontSize=12;fillColor=#F1F8EC;strokeColor=#5C9E31;strokeWidth=2;`,
	subnet: `${GROUP}image=img/lib/azure2/${SUBNET_ICON};imageWidth=22;imageHeight=13;spacingLeft=32;fontSize=11;fillColor=#FFFFFF;strokeColor=#5C9E31;dashed=1;dashPattern=4 3;fontStyle=0;`,
};

export const EDGE_STYLES = {
	reference: "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#6B7280;fontSize=10;",
	privateLink: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;dashed=1;strokeColor=#8661C5;strokeWidth=2;fontSize=10;fontColor=#8661C5;",
	publicIp: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#D83B01;strokeWidth=2;fontSize=10;fontColor=#D83B01;",
	peering: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;startArrow=block;startFill=1;endArrow=block;endFill=1;strokeColor=#5C9E31;strokeWidth=3;fontSize=10;fontColor=#3B6E1F;",
	vnetRule: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=open;dashed=1;dashPattern=1 3;strokeColor=#5C9E31;fontSize=10;fontColor=#3B6E1F;",
	child: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=diamondThin;endFill=0;startArrow=none;strokeColor=#9CA3AF;fontSize=10;",
	dnsLink: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=open;dashed=1;strokeColor=#0078D4;fontSize=10;fontColor=#0078D4;",
};
