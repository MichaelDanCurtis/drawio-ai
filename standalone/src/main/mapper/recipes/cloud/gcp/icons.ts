/**
 * Google Cloud asset types → draw.io's GCP product icons (the `mxgraph.gcp2.*`
 * stencils behind the "GCP" shape library). The names are checked against the
 * stencils bundled with draw.io in the tests.
 */

const ICONS: Record<string, string> = {
	"compute.googleapis.com/Instance": "compute_engine",
	"compute.googleapis.com/InstanceGroup": "compute_engine",
	"compute.googleapis.com/InstanceGroupManager": "compute_engine",
	"compute.googleapis.com/RegionInstanceGroupManager": "compute_engine",
	"compute.googleapis.com/InstanceTemplate": "compute_engine",
	"compute.googleapis.com/Image": "compute_engine",
	"compute.googleapis.com/Disk": "persistent_disk",
	"compute.googleapis.com/RegionDisk": "persistent_disk",
	"compute.googleapis.com/Snapshot": "persistent_disk_snapshot",
	"compute.googleapis.com/Network": "virtual_private_cloud",
	"compute.googleapis.com/Subnetwork": "virtual_private_cloud",
	"compute.googleapis.com/Firewall": "cloud_firewall_rules",
	"compute.googleapis.com/FirewallPolicy": "cloud_firewall_rules",
	"compute.googleapis.com/Address": "cloud_external_ip_addresses",
	"compute.googleapis.com/GlobalAddress": "cloud_external_ip_addresses",
	"compute.googleapis.com/ForwardingRule": "cloud_load_balancing",
	"compute.googleapis.com/GlobalForwardingRule": "cloud_load_balancing",
	"compute.googleapis.com/BackendService": "cloud_load_balancing",
	"compute.googleapis.com/RegionBackendService": "cloud_load_balancing",
	"compute.googleapis.com/BackendBucket": "cloud_load_balancing",
	"compute.googleapis.com/UrlMap": "cloud_load_balancing",
	"compute.googleapis.com/TargetHttpProxy": "cloud_load_balancing",
	"compute.googleapis.com/TargetHttpsProxy": "cloud_load_balancing",
	"compute.googleapis.com/TargetPool": "cloud_load_balancing",
	"compute.googleapis.com/HealthCheck": "cloud_load_balancing",
	"compute.googleapis.com/NetworkEndpointGroup": "cloud_load_balancing",
	"compute.googleapis.com/SslCertificate": "cloud_load_balancing",
	"compute.googleapis.com/Router": "cloud_router",
	"compute.googleapis.com/VpnGateway": "cloud_vpn",
	"compute.googleapis.com/TargetVpnGateway": "cloud_vpn",
	"compute.googleapis.com/VpnTunnel": "cloud_vpn",
	"compute.googleapis.com/ExternalVpnGateway": "cloud_vpn",
	"compute.googleapis.com/Interconnect": "dedicated_interconnect",
	"compute.googleapis.com/InterconnectAttachment": "dedicated_interconnect",
	"compute.googleapis.com/SecurityPolicy": "cloud_armor",
	"compute.googleapis.com/Route": "cloud_routes",
	"container.googleapis.com/Cluster": "container_engine",
	"container.googleapis.com/NodePool": "container_engine",
	"run.googleapis.com/Service": "cloud_run",
	"run.googleapis.com/Job": "cloud_run",
	"cloudfunctions.googleapis.com/Function": "cloud_functions",
	"cloudfunctions.googleapis.com/CloudFunction": "cloud_functions",
	"appengine.googleapis.com/Application": "app_engine",
	"appengine.googleapis.com/Service": "app_engine",
	"sqladmin.googleapis.com/Instance": "cloud_sql",
	"storage.googleapis.com/Bucket": "cloud_storage",
	"pubsub.googleapis.com/Topic": "cloud_pubsub",
	"pubsub.googleapis.com/Subscription": "cloud_pubsub",
	"bigquery.googleapis.com/Dataset": "bigquery",
	"bigquery.googleapis.com/Table": "bigquery",
	"spanner.googleapis.com/Instance": "cloud_spanner",
	"spanner.googleapis.com/Database": "cloud_spanner",
	"bigtableadmin.googleapis.com/Instance": "cloud_bigtable",
	"bigtableadmin.googleapis.com/Cluster": "cloud_bigtable",
	"bigtableadmin.googleapis.com/Table": "cloud_bigtable",
	"redis.googleapis.com/Instance": "cloud_memorystore",
	"redis.googleapis.com/Cluster": "cloud_memorystore",
	"memcache.googleapis.com/Instance": "cloud_memorystore",
	"file.googleapis.com/Instance": "cloud_filestore",
	"firestore.googleapis.com/Database": "cloud_firestore",
	"datastore.googleapis.com/Database": "cloud_datastore",
	"cloudkms.googleapis.com/KeyRing": "key_management_service",
	"cloudkms.googleapis.com/CryptoKey": "key_management_service",
	"secretmanager.googleapis.com/Secret": "key",
	"iam.googleapis.com/ServiceAccount": "cloud_iam",
	"iam.googleapis.com/Role": "cloud_iam",
	"dns.googleapis.com/ManagedZone": "cloud_dns",
	"dns.googleapis.com/Policy": "cloud_dns",
	"vpcaccess.googleapis.com/Connector": "cloud_network",
	"artifactregistry.googleapis.com/Repository": "container_registry",
	"containerregistry.googleapis.com/Image": "container_registry",
	"cloudbuild.googleapis.com/BuildTrigger": "container_builder",
	"dataflow.googleapis.com/Job": "cloud_dataflow",
	"dataproc.googleapis.com/Cluster": "cloud_dataproc",
	"composer.googleapis.com/Environment": "cloud_composer",
	"aiplatform.googleapis.com/Endpoint": "cloud_machine_learning",
	"aiplatform.googleapis.com/Model": "cloud_machine_learning",
	"aiplatform.googleapis.com/Dataset": "cloud_machine_learning",
	"notebooks.googleapis.com/Instance": "cloud_machine_learning",
	"tpu.googleapis.com/Node": "cloud_tpu",
	"cloudscheduler.googleapis.com/Job": "cloud_scheduler",
	"cloudtasks.googleapis.com/Queue": "cloud_tasks",
	"logging.googleapis.com/LogSink": "logging",
	"logging.googleapis.com/LogBucket": "logging",
	"monitoring.googleapis.com/AlertPolicy": "stackdriver",
	"apigateway.googleapis.com/Gateway": "cloud_endpoints",
	"apigateway.googleapis.com/Api": "cloud_endpoints",
	"servicedirectory.googleapis.com/Namespace": "service_discovery",
	"datafusion.googleapis.com/Instance": "cloud_data_fusion",
	"datacatalog.googleapis.com/EntryGroup": "cloud_data_catalog",
	"iap.googleapis.com/Tunnel": "identity_aware_proxy",
	"securitycenter.googleapis.com/Source": "cloud_security_command_center",
};

export const GENERIC_STENCIL = "blue_hexagon";

export function gcpStencil(assetType: string, data?: any): string | undefined {
	if (assetType === "compute.googleapis.com/Router" && Array.isArray(data?.nats) && data.nats.length) return "cloud_nat";
	return ICONS[assetType];
}

export function allGcpStencils(): string[] {
	return [...new Set([...Object.values(ICONS), "cloud_nat", GENERIC_STENCIL])];
}

export function mappedGcpTypes(): string[] {
	return Object.keys(ICONS);
}

export const ICON_STYLE = (stencil: string) =>
	`sketch=0;html=1;aspect=fixed;strokeColor=none;shadow=0;fillColor=#5184F3;fontSize=11;fontColor=#424242;shape=mxgraph.gcp2.${stencil};`;

/** Google's own zone colours for architecture diagrams (the "GCP / Zones" library). */
const ZONE = "rounded=1;absoluteArcSize=1;arcSize=4;html=1;whiteSpace=wrap;container=1;collapsible=0;recursiveResize=0;strokeColor=none;shadow=0;align=left;verticalAlign=top;spacingLeft=10;spacingTop=4;fontColor=#5F6368;";
export const CONTAINER_STYLES = {
	project: `${ZONE}fillColor=#F6F6F6;fontSize=13;fontStyle=1;`,
	network: `${ZONE}fillColor=#E3F2FD;fontSize=12;fontStyle=1;strokeColor=#4284F3;`,
	region: `${ZONE}fillColor=#ECEFF1;fontSize=11;fontStyle=1;`,
	subnet: `${ZONE}fillColor=#EDE7F6;fontSize=11;fontStyle=0;`,
};

export const EDGE_STYLES = {
	reference: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=blockThin;endFill=1;strokeColor=#9E9E9E;strokeWidth=1;fontSize=10;",
	flow: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=blockThin;endFill=1;strokeColor=#4284F3;strokeWidth=2;fontSize=10;fontColor=#4284F3;",
	firewall: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=blockThin;endFill=1;dashed=1;strokeColor=#EA4335;fontSize=10;fontColor=#EA4335;",
	peering: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;startArrow=blockThin;startFill=1;endArrow=blockThin;endFill=1;strokeColor=#34A853;strokeWidth=3;fontSize=10;fontColor=#34A853;",
	external: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=blockThin;endFill=1;strokeColor=#F4B400;strokeWidth=2;fontSize=10;fontColor=#B06000;",
};
