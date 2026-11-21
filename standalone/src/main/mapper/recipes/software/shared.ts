/**
 * Shared pieces of the software mappers: draw.io styles, reading addresses out of
 * configuration values without keeping secrets, and the technology catalogue
 * (which library / image / URL scheme means which kind of system).
 */

// ----- styles -----

export const STYLE = {
	service:
		"rounded=1;arcSize=4;whiteSpace=wrap;html=1;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=#f5f9ff;strokeColor=#6c8ebf;",
	facet: "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#9fb3d1;fontSize=10;fontColor=#334155;",
	database: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=10;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=11;",
	cache: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=10;fillColor=#f8cecc;strokeColor=#b85450;fontSize=11;",
	search: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=10;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=11;",
	storage: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=10;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=11;",
	queue: "shape=process;whiteSpace=wrap;html=1;backgroundOutline=1;size=0.08;fillColor=#e1d5e7;strokeColor=#9673a6;fontSize=11;",
	broker:
		"rounded=1;arcSize=6;whiteSpace=wrap;html=1;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=#f4eef7;strokeColor=#9673a6;",
	external: "ellipse;shape=cloud;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;fontSize=11;",
	gateway: "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;fontSize=11;",
	other: "rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#999999;fontSize=11;dashed=1;",
	actor: "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;fillColor=#f5f5f5;strokeColor=#666666;",
	group:
		"rounded=1;arcSize=3;whiteSpace=wrap;html=1;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=none;strokeColor=#b0b8c4;dashed=1;",
	folder:
		"rounded=1;arcSize=3;whiteSpace=wrap;html=1;container=1;collapsible=0;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fillColor=#fafafa;strokeColor=#b0b8c4;",
	module: "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=11;",
	folderNode: "shape=folder;tabWidth=40;tabHeight=12;tabPosition=left;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=11;spacingTop=8;",
	table: (fill: string, stroke: string) =>
		`swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};rounded=1;arcSize=4;`,
	edge: "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#6b7280;fontSize=10;",
	edgeAsync: "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=open;endFill=0;dashed=1;strokeColor=#9673a6;fontSize=10;",
	edgeWeak: "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=open;endFill=0;dashed=1;strokeColor=#9ca3af;fontSize=10;",
	edgeCycle: "edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#dc2626;fontSize=10;",
	extends: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=0;endSize=10;strokeColor=#374151;",
	implements: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=0;endSize=10;dashed=1;strokeColor=#374151;",
	association: "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=open;endFill=0;strokeColor=#6b7280;",
};

// ----- secrets -----

/** Keys whose values are never kept (unless the key names an address, which is then reduced to its host). */
const SECRET_WORD = /(PASS(WORD|WD|PHRASE)?|PWD|SECRET|TOKEN|API_?KEY|APIKEY|ACCESS_?KEY|ACCOUNT_?KEY|PRIVATE|CREDENTIAL|SALT|SIGNATURE|CERT|COOKIE|SESSION_?KEY|ENCRYPTION|SIGNING|(^|_)KEY$|(^|_)AUTH($|_(?!URL|URI|HOST|ENDPOINT|SERVER|DOMAIN|ISSUER)))/i;
const ADDRESS_SUFFIX = /(URL|URI|DSN|HOST|HOSTNAME|HOSTS|ADDR|ADDRESS|ENDPOINT|ENDPOINTS|SERVER|SERVERS|BROKER|BROKERS|BOOTSTRAP_SERVERS|NODES|CONNECTION|CONNECTION_?STRING|CONN_?STR|CONNSTR|DATASOURCE|CONNECT)$/i;

export function isSecretKey(key: string): boolean {
	const k = key.replace(/[.\-:]/g, "_");
	return SECRET_WORD.test(k) && !ADDRESS_SUFFIX.test(k);
}

/** Whether a key names an address (DATABASE_URL, REDIS_HOST, KAFKA_BROKERS, ConnectionStrings:Orders...). */
export function isAddressKey(key: string): boolean {
	const k = key.replace(/[.\-:]/g, "_");
	return ADDRESS_SUFFIX.test(k) || /CONNECTIONSTRINGS?_/i.test(k) || /^(DATABASE|DB|REDIS|MONGO(DB)?|AMQP|RABBITMQ|KAFKA|NATS|ELASTICSEARCH|SPRING_DATASOURCE)(_URL)?$/i.test(k);
}

/** Anything that looks like a credential inside a free-form string, replaced by ***. */
export function scrub(text: string): string {
	return text
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/gi, "$1")
		.replace(/\b(password|pwd|secret|token|apikey|api_key|accountkey|sharedaccesskey|access_key|sig)\s*[=:]\s*[^\s;&'",]+/gi, "$1=***")
		.replace(/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{6,}/g, "***")
		.replace(/\bAKIA[0-9A-Z]{12,}/g, "***")
		.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "***")
		.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "***");
}

// ----- addresses -----

export interface HostPort {
	host: string;
	port?: number;
}

/** What a configuration value points at: scheme and hosts only, never credentials, paths or query strings. */
export interface Address {
	scheme?: string;
	hosts: HostPort[];
	/** Database name (database URLs and connection strings only). */
	database?: string;
	/** Queue / topic / bucket name when the address names one (SQS queue URLs, s3://bucket). */
	resourceName?: string;
}

const HOSTNAME = /^(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62})(?:\.[A-Za-z0-9_-]{1,63})*|\[[0-9A-Fa-f:.]+\])$/;
const SAFE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function hostPorts(part: string, defaultPort?: number): HostPort[] {
	const out: HostPort[] = [];
	for (const raw of part.split(",")) {
		const s = raw.trim();
		if (!s) continue;
		const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(s);
		if (!m) continue;
		const host = m[1].toLowerCase();
		if (!HOSTNAME.test(host) || !/[a-z]/i.test(host.replace(/^\[.*\]$/, "v6"))) continue;
		out.push({ host, port: m[2] ? Number(m[2]) : defaultPort });
	}
	return out;
}

/** Replaces ${VAR}, ${VAR:-default} and $VAR with known values (compose / shell style). */
export function interpolate(value: string, env: (name: string) => string | undefined): string {
	return value
		.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-=]([^}]*))?\}/g, (_, name, def) => env(name) ?? def ?? "")
		.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => env(name) ?? "");
}

/**
 * Reads where a configuration value points. Only the scheme, hosts and ports are
 * kept (plus a database / queue name); user names, passwords, keys, paths and
 * query strings are dropped. Returns undefined for values that are not addresses.
 */
export function parseAddress(raw: string, opts: { bare?: boolean } = {}): Address | undefined {
	let v = String(raw ?? "").trim().replace(/^["']|["']$/g, "");
	if (!v || v.length > 4000 || /\{\{|\$\(|<[a-z_-]+>/i.test(v)) return undefined;
	v = v.replace(/^jdbc:/i, "");
	// ADO.NET / Azure style: Key=Value;Key=Value
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && /^[A-Za-z][A-Za-z ]*=[^;]*;/.test(v)) return parseKeyValueConnection(v);
	const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#;]*)(\/[^?#;]*)?/i.exec(v);
	if (url) {
		const scheme = url[1].toLowerCase();
		const authority = url[2].slice(url[2].lastIndexOf("@") + 1);
		const hosts = hostPorts(authority);
		const path = (url[3] ?? "").split("/").filter(Boolean);
		const addr: Address = { scheme, hosts };
		if (DB_SCHEMES.has(scheme) && path[0] && SAFE_NAME.test(path[0]) && !/^\d+$/.test(path[0])) addr.database = path[0];
		if ((scheme === "s3" || scheme === "gs") && hosts[0]) {
			addr.resourceName = hosts[0].host;
		}
		if (/^sqs\.[a-z0-9-]+\.amazonaws\.com$/.test(hosts[0]?.host ?? "") && path.length >= 2 && SAFE_NAME.test(path[path.length - 1])) {
			addr.resourceName = path[path.length - 1];
		}
		if (/^sqlserver$/.test(scheme)) {
			// jdbc:sqlserver://host:1433;databaseName=x;password=y
			const db = /;\s*(?:databaseName|database)=([^;]+)/i.exec(v)?.[1];
			if (db && SAFE_NAME.test(db)) addr.database = db;
		}
		return hosts.length || addr.resourceName ? addr : undefined;
	}
	if (/^arn:aws:(sns|sqs|s3|dynamodb|kinesis|lambda):/.test(v)) {
		const parts = v.split(":");
		const name = parts.slice(5).join(":").split("/").pop() ?? "";
		return { scheme: `aws-${parts[2]}`, hosts: [], resourceName: SAFE_NAME.test(name) ? name : undefined };
	}
	if (opts.bare) {
		const hosts = hostPorts(v);
		if (hosts.length && hosts.length === v.split(",").length && !/^(true|false|yes|no|on|off|null|none|localhost:?)$/i.test(v)) return { hosts };
	}
	return undefined;
}

function parseKeyValueConnection(v: string): Address | undefined {
	const kv = new Map<string, string>();
	for (const part of v.split(";")) {
		const i = part.indexOf("=");
		if (i > 0) kv.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
	}
	const get = (...keys: string[]) => keys.map((k) => kv.get(k)).find((x) => x);
	const endpoint = get("endpoint", "blobendpoint", "queueendpoint", "accountendpoint");
	if (endpoint) {
		const a = parseAddress(endpoint);
		if (a) return { ...a, scheme: a.scheme === "sb" ? "sb" : kv.has("accountendpoint") ? "cosmos" : a.scheme };
	}
	const account = get("accountname");
	if (account && SAFE_NAME.test(account)) {
		const suffix = get("endpointsuffix") ?? "core.windows.net";
		return { scheme: "azure-storage", hosts: [{ host: `${account.toLowerCase()}.blob.${suffix}` }] };
	}
	const server = get("server", "data source", "host", "hostname", "address", "addr", "network address", "host name");
	if (!server) return undefined;
	const cleaned = server.replace(/^tcp:/i, "");
	const [hostPart, portPart] = cleaned.includes(",") ? cleaned.split(",") : [cleaned, get("port")];
	const hosts = hostPorts(hostPart.split("\\")[0], portPart && /^\d+$/.test(portPart.trim()) ? Number(portPart) : undefined);
	if (!hosts.length) return undefined;
	const db = get("database", "initial catalog", "dbname");
	const isSqlServer = kv.has("initial catalog") || kv.has("data source") || /database\.windows\.net$/.test(hosts[0].host) || hosts[0].port === 1433;
	return { scheme: isSqlServer ? "sqlserver" : undefined, hosts, database: db && SAFE_NAME.test(db) ? db : undefined };
}

// ----- technologies -----

export type ResourceKind = "database" | "cache" | "queue" | "topic" | "storage" | "search" | "external" | "gateway" | "observability" | "auth" | "mail" | "other";

export interface Tech {
	id: string;
	label: string;
	kind: ResourceKind;
	protocol: string;
	port?: number;
}

const T = (id: string, label: string, kind: ResourceKind, protocol: string, port?: number): Tech => ({ id, label, kind, protocol, port });

export const TECH: Record<string, Tech> = {
	postgres: T("postgres", "PostgreSQL", "database", "postgres", 5432),
	mysql: T("mysql", "MySQL", "database", "mysql", 3306),
	sqlserver: T("sqlserver", "SQL Server", "database", "tds", 1433),
	oracle: T("oracle", "Oracle", "database", "oracle", 1521),
	sqlite: T("sqlite", "SQLite", "database", "file"),
	mongodb: T("mongodb", "MongoDB", "database", "mongodb", 27017),
	cassandra: T("cassandra", "Cassandra", "database", "cql", 9042),
	neo4j: T("neo4j", "Neo4j", "database", "bolt", 7687),
	clickhouse: T("clickhouse", "ClickHouse", "database", "clickhouse", 8123),
	influxdb: T("influxdb", "InfluxDB", "database", "http", 8086),
	couchdb: T("couchdb", "CouchDB", "database", "http", 5984),
	dynamodb: T("dynamodb", "DynamoDB", "database", "https"),
	cosmos: T("cosmos", "Cosmos DB", "database", "https"),
	firestore: T("firestore", "Firestore", "database", "grpc"),
	bigquery: T("bigquery", "BigQuery", "database", "https"),
	spanner: T("spanner", "Spanner", "database", "grpc"),
	sql: T("sql", "SQL database", "database", "sql"),
	redis: T("redis", "Redis", "cache", "redis", 6379),
	memcached: T("memcached", "Memcached", "cache", "memcached", 11211),
	kafka: T("kafka", "Kafka", "queue", "kafka", 9092),
	rabbitmq: T("rabbitmq", "RabbitMQ", "queue", "amqp", 5672),
	nats: T("nats", "NATS", "queue", "nats", 4222),
	mqtt: T("mqtt", "MQTT broker", "queue", "mqtt", 1883),
	sqs: T("sqs", "Amazon SQS", "queue", "https"),
	sns: T("sns", "Amazon SNS", "topic", "https"),
	kinesis: T("kinesis", "Kinesis", "queue", "https"),
	eventbridge: T("eventbridge", "EventBridge", "topic", "https"),
	servicebus: T("servicebus", "Azure Service Bus", "queue", "amqp"),
	eventhubs: T("eventhubs", "Azure Event Hubs", "queue", "amqp"),
	pubsub: T("pubsub", "Google Pub/Sub", "topic", "grpc"),
	s3: T("s3", "Amazon S3", "storage", "https"),
	azureblob: T("azureblob", "Azure Blob Storage", "storage", "https"),
	gcs: T("gcs", "Cloud Storage", "storage", "https"),
	minio: T("minio", "MinIO (S3)", "storage", "s3", 9000),
	elasticsearch: T("elasticsearch", "Elasticsearch", "search", "http", 9200),
	zookeeper: T("zookeeper", "ZooKeeper", "other", "zk", 2181),
	etcd: T("etcd", "etcd", "other", "grpc", 2379),
	consul: T("consul", "Consul", "other", "http", 8500),
	vault: T("vault", "Vault", "auth", "https", 8200),
	keycloak: T("keycloak", "Keycloak", "auth", "http", 8080),
	smtp: T("smtp", "Mail (SMTP)", "mail", "smtp", 25),
	proxy: T("proxy", "Reverse proxy", "gateway", "http", 80),
	observability: T("observability", "Observability", "observability", "http"),
	localstack: T("localstack", "LocalStack (AWS)", "other", "https", 4566),
	azurite: T("azurite", "Azurite (Azure Storage)", "storage", "https", 10000),
	grpc: T("grpc", "gRPC service", "external", "grpc"),
	http: T("http", "HTTP API", "external", "https"),
};

/** URL schemes that name a technology. */
const SCHEMES: Record<string, string> = {
	postgres: "postgres",
	postgresql: "postgres",
	postgis: "postgres",
	"postgresql+psycopg2": "postgres",
	"postgresql+asyncpg": "postgres",
	mysql: "mysql",
	"mysql+pymysql": "mysql",
	mariadb: "mysql",
	sqlserver: "sqlserver",
	mssql: "sqlserver",
	oracle: "oracle",
	sqlite: "sqlite",
	mongodb: "mongodb",
	"mongodb+srv": "mongodb",
	cassandra: "cassandra",
	bolt: "neo4j",
	neo4j: "neo4j",
	"neo4j+s": "neo4j",
	clickhouse: "clickhouse",
	redis: "redis",
	rediss: "redis",
	memcached: "memcached",
	amqp: "rabbitmq",
	amqps: "rabbitmq",
	kafka: "kafka",
	nats: "nats",
	mqtt: "mqtt",
	mqtts: "mqtt",
	sb: "servicebus",
	s3: "s3",
	gs: "gcs",
	smtp: "smtp",
	smtps: "smtp",
	grpc: "grpc",
	"azure-storage": "azureblob",
	cosmos: "cosmos",
	"aws-sns": "sns",
	"aws-sqs": "sqs",
	"aws-s3": "s3",
	"aws-dynamodb": "dynamodb",
	"aws-kinesis": "kinesis",
};
const DB_SCHEMES = new Set(Object.entries(SCHEMES).filter(([, t]) => TECH[t].kind === "database").map(([s]) => s));

/** Managed services recognised by host name. */
const HOSTS: [RegExp, string][] = [
	[/\.rds\.amazonaws\.com$/, "sql"],
	[/\.cache\.amazonaws\.com$/, "redis"],
	[/^sqs\.[a-z0-9-]+\.amazonaws\.com$/, "sqs"],
	[/^sns\.[a-z0-9-]+\.amazonaws\.com$/, "sns"],
	[/(^|\.)s3[.-]([a-z0-9-]+\.)?amazonaws\.com$/, "s3"],
	[/^dynamodb\.[a-z0-9-]+\.amazonaws\.com$/, "dynamodb"],
	[/^kinesis\.[a-z0-9-]+\.amazonaws\.com$/, "kinesis"],
	[/\.es\.amazonaws\.com$|\.aoss\.amazonaws\.com$|\.es\.io$|\.elastic-cloud\.com$/, "elasticsearch"],
	[/\.kafka\.[a-z0-9-]+\.amazonaws\.com$|\.confluent\.cloud$/, "kafka"],
	[/\.postgres\.database\.azure\.com$|\.supabase\.co$|\.neon\.tech$/, "postgres"],
	[/\.mysql\.database\.azure\.com$/, "mysql"],
	[/\.database\.windows\.net$/, "sqlserver"],
	[/\.documents\.azure\.com$/, "cosmos"],
	[/\.redis\.cache\.windows\.net$|\.upstash\.io$/, "redis"],
	[/\.servicebus\.windows\.net$/, "servicebus"],
	[/\.blob\.core\.windows\.net$/, "azureblob"],
	[/^storage\.googleapis\.com$/, "gcs"],
	[/^pubsub\.googleapis\.com$/, "pubsub"],
	[/^firestore\.googleapis\.com$/, "firestore"],
	[/^bigquery\.googleapis\.com$/, "bigquery"],
	[/\.mongodb\.net$/, "mongodb"],
];

/** Keys that hint at a technology when the value has no scheme (REDIS_HOST=cache). */
const KEY_HINTS: [RegExp, string][] = [
	[/POSTGRES|(^|_)PG_?|PGHOST/i, "postgres"],
	[/MYSQL|MARIADB/i, "mysql"],
	[/MSSQL|SQLSERVER|SQL_SERVER/i, "sqlserver"],
	[/MONGO/i, "mongodb"],
	[/REDIS|VALKEY/i, "redis"],
	[/MEMCACHE/i, "memcached"],
	[/KAFKA/i, "kafka"],
	[/RABBIT|AMQP/i, "rabbitmq"],
	[/NATS/i, "nats"],
	[/MQTT/i, "mqtt"],
	[/ELASTIC|OPENSEARCH/i, "elasticsearch"],
	[/CASSANDRA|SCYLLA/i, "cassandra"],
	[/NEO4J/i, "neo4j"],
	[/CLICKHOUSE/i, "clickhouse"],
	[/SQS/i, "sqs"],
	[/SNS/i, "sns"],
	[/DYNAMO/i, "dynamodb"],
	[/COSMOS/i, "cosmos"],
	[/SERVICE_?BUS/i, "servicebus"],
	[/EVENT_?HUB/i, "eventhubs"],
	[/PUBSUB/i, "pubsub"],
	[/S3_|_S3|(^|_)S3$/i, "s3"],
	[/BLOB|AZURE_?STORAGE/i, "azureblob"],
	[/GCS|GOOGLE_?STORAGE/i, "gcs"],
	[/SMTP|MAIL/i, "smtp"],
	[/ZOOKEEPER/i, "zookeeper"],
	[/ETCD/i, "etcd"],
	[/CONSUL/i, "consul"],
	[/VAULT/i, "vault"],
	[/KEYCLOAK|OIDC|OAUTH|AUTH0|OKTA/i, "keycloak"],
	[/DATABASE|(^|_)DB(_|$)|DATASOURCE|CONNECTIONSTRINGS?_/i, "sql"],
];

const PORTS: Record<number, string> = { 5432: "postgres", 3306: "mysql", 1433: "sqlserver", 1521: "oracle", 27017: "mongodb", 6379: "redis", 11211: "memcached", 9092: "kafka", 5672: "rabbitmq", 4222: "nats", 1883: "mqtt", 9200: "elasticsearch", 9042: "cassandra", 7687: "neo4j", 2181: "zookeeper" };

/** The technology an address points at, from its scheme, host, port or the key it was found under. */
export function techOf(addr: Address | undefined, key = ""): Tech | undefined {
	const scheme = addr?.scheme;
	if (scheme && SCHEMES[scheme]) return TECH[SCHEMES[scheme]];
	const host = addr?.hosts[0]?.host ?? "";
	for (const [re, t] of HOSTS) if (re.test(host)) return TECH[t];
	for (const [re, t] of KEY_HINTS) if (re.test(key)) return TECH[t];
	const port = addr?.hosts[0]?.port;
	if (port && PORTS[port]) return TECH[PORTS[port]];
	if (scheme === "http" || scheme === "https" || scheme === "ws" || scheme === "wss") return TECH.http;
	return undefined;
}

/** Container images of well-known infrastructure (compose services and Kubernetes workloads). */
const IMAGES: [RegExp, string][] = [
	[/(^|\/)(postgres|postgis|timescaledb|pgvector|supabase\/postgres|bitnami\/postgresql|cockroach)/, "postgres"],
	[/(^|\/)(mysql|mariadb|percona|bitnami\/mysql)/, "mysql"],
	[/mssql\/server|azure-sql-edge/, "sqlserver"],
	[/(^|\/)(mongo|bitnami\/mongodb)/, "mongodb"],
	[/(^|\/)(redis|valkey|keydb|bitnami\/redis|dragonfly)/, "redis"],
	[/(^|\/)memcached/, "memcached"],
	[/(^|\/)(cp-kafka|kafka|redpanda)|bitnami\/kafka|apache\/kafka/, "kafka"],
	[/(^|\/)(cp-zookeeper|zookeeper)/, "zookeeper"],
	[/(^|\/)rabbitmq/, "rabbitmq"],
	[/(^|\/)nats/, "nats"],
	[/(^|\/)(eclipse-mosquitto|emqx)/, "mqtt"],
	[/(^|\/)(elasticsearch|opensearch)|elastic\/elasticsearch/, "elasticsearch"],
	[/(^|\/)(cassandra|scylla)/, "cassandra"],
	[/(^|\/)neo4j/, "neo4j"],
	[/(^|\/)clickhouse/, "clickhouse"],
	[/(^|\/)influxdb/, "influxdb"],
	[/(^|\/)couchdb/, "couchdb"],
	[/(^|\/)minio/, "minio"],
	[/localstack/, "localstack"],
	[/azurite/, "azurite"],
	[/(^|\/)etcd|bitnami\/etcd/, "etcd"],
	[/(^|\/)consul/, "consul"],
	[/(^|\/)vault/, "vault"],
	[/keycloak/, "keycloak"],
	[/mailhog|mailpit|maildev|smtp/, "smtp"],
	[/(^|\/)(nginx|traefik|envoy|haproxy|caddy|kong)/, "proxy"],
	[/(^|\/)(prometheus|grafana|jaeger|zipkin|loki|tempo|otel|opentelemetry|datadog|kibana|fluent)/, "observability"],
];

export function techOfImage(image: string): Tech | undefined {
	const repo = image.toLowerCase().replace(/^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?\//, "").replace(/[:@].*$/, "");
	for (const [re, t] of IMAGES) if (re.test(repo)) return TECH[t];
	return undefined;
}

/** "ghcr.io/acme/orders-api:1.2" → "orders-api". */
export function imageBase(image: string): string {
	return image.replace(/[:@][^/]*$/, "").split("/").pop()!.toLowerCase();
}

/** Hosts that are documentation, schemas or placeholders, not systems the code talks to. */
export function isNoiseHost(host: string): boolean {
	return (
		/(^|\.)(example\.(com|org|net)|example|test|invalid|localhost\.localdomain|w3\.org|schema\.org|json-schema\.org|xmlns\.com|purl\.org|openxmlformats\.org|apache\.org|mozilla\.org|wikipedia\.org|ietf\.org|creativecommons\.org|gnu\.org|opensource\.org|semver\.org|npmjs\.(com|org)|yarnpkg\.com|unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|readthedocs\.io|docs\.[a-z0-9-]+\.[a-z]+|shields\.io|badge\.fury\.io|travis-ci\.org|codecov\.io|stackoverflow\.com|youtube\.com|twitter\.com|x\.com|linkedin\.com|facebook\.com|medium\.com)$/i.test(host) ||
		host === "github.com" ||
		host === "www.github.com" ||
		host === "raw.githubusercontent.com" ||
		host === "gist.github.com"
	);
}

export function isLocalHost(host: string): boolean {
	return /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\]|host\.docker\.internal|::1)$/.test(host);
}

// ----- libraries -----

export interface LibraryHit {
	tech: Tech;
	/** The package or module name that matched. */
	name: string;
}

/**
 * Client libraries by package / module name, across ecosystems (npm, PyPI, Go,
 * Maven, NuGet, RubyGems). A name matches itself and its sub-modules.
 */
const LIBRARIES: [string, string[]][] = [
	["postgres", ["pg", "postgres", "pg-promise", "pg-pool", "@neondatabase/serverless", "@vercel/postgres", "psycopg2", "psycopg2-binary", "psycopg", "asyncpg", "github.com/lib/pq", "github.com/jackc/pgx", "org.postgresql", "Npgsql", "Npgsql.EntityFrameworkCore.PostgreSQL", "postgresql"]],
	["mysql", ["mysql", "mysql2", "pymysql", "MySQLdb", "mysqlclient", "aiomysql", "github.com/go-sql-driver/mysql", "com.mysql", "mysql:mysql-connector-java", "MySql.Data", "MySqlConnector", "mysql2 (gem)"]],
	["sqlserver", ["mssql", "tedious", "pyodbc", "pymssql", "github.com/denisenkom/go-mssqldb", "github.com/microsoft/go-mssqldb", "com.microsoft.sqlserver", "Microsoft.Data.SqlClient", "System.Data.SqlClient", "Microsoft.EntityFrameworkCore.SqlServer"]],
	["oracle", ["oracledb", "cx_Oracle", "github.com/godror/godror", "com.oracle.database.jdbc", "Oracle.ManagedDataAccess"]],
	["sqlite", ["sqlite3", "better-sqlite3", "sqlite", "github.com/mattn/go-sqlite3", "modernc.org/sqlite", "org.xerial", "Microsoft.Data.Sqlite"]],
	["mongodb", ["mongodb", "mongoose", "pymongo", "motor", "mongoengine", "go.mongodb.org/mongo-driver", "org.mongodb", "MongoDB.Driver", "mongo", "mongoid"]],
	["cassandra", ["cassandra-driver", "github.com/gocql/gocql", "com.datastax"]],
	["neo4j", ["neo4j-driver", "neo4j", "github.com/neo4j/neo4j-go-driver", "org.neo4j"]],
	["clickhouse", ["@clickhouse/client", "clickhouse-driver", "clickhouse_connect", "github.com/ClickHouse/clickhouse-go"]],
	["influxdb", ["@influxdata/influxdb-client", "influxdb-client", "influxdb_client"]],
	["redis", ["redis", "ioredis", "@redis/client", "@upstash/redis", "aioredis", "redis-py-cluster", "github.com/go-redis/redis", "github.com/redis/go-redis", "github.com/gomodule/redigo", "redis.clients", "io.lettuce", "StackExchange.Redis", "org.redisson"]],
	["memcached", ["memcached", "memjs", "pymemcache", "github.com/bradfitz/gomemcache", "EnyimMemcached"]],
	["kafka", ["kafkajs", "node-rdkafka", "@confluentinc/kafka-javascript", "kafka", "kafka-python", "confluent_kafka", "confluent-kafka", "aiokafka", "github.com/segmentio/kafka-go", "github.com/Shopify/sarama", "github.com/IBM/sarama", "github.com/confluentinc/confluent-kafka-go", "org.apache.kafka", "org.springframework.kafka", "Confluent.Kafka", "ruby-kafka", "rdkafka"]],
	["rabbitmq", ["amqplib", "amqp-connection-manager", "rascal", "pika", "aio_pika", "aio-pika", "kombu", "github.com/streadway/amqp", "github.com/rabbitmq/amqp091-go", "com.rabbitmq", "org.springframework.amqp", "RabbitMQ.Client", "bunny", "MassTransit.RabbitMQ"]],
	["nats", ["nats", "nats.ws", "nats-py", "github.com/nats-io/nats.go", "io.nats", "NATS.Client"]],
	["mqtt", ["mqtt", "paho-mqtt", "paho.mqtt", "github.com/eclipse/paho.mqtt.golang", "MQTTnet"]],
	["sqs", ["@aws-sdk/client-sqs", "sqs-consumer", "github.com/aws/aws-sdk-go-v2/service/sqs", "github.com/aws/aws-sdk-go/service/sqs", "software.amazon.awssdk.services.sqs", "com.amazonaws.services.sqs", "AWSSDK.SQS", "Amazon.SQS"]],
	["sns", ["@aws-sdk/client-sns", "github.com/aws/aws-sdk-go-v2/service/sns", "software.amazon.awssdk.services.sns", "AWSSDK.SimpleNotificationService", "Amazon.SimpleNotificationService"]],
	["s3", ["@aws-sdk/client-s3", "@aws-sdk/lib-storage", "@aws-sdk/s3-request-presigner", "github.com/aws/aws-sdk-go-v2/service/s3", "github.com/aws/aws-sdk-go/service/s3", "software.amazon.awssdk.services.s3", "com.amazonaws.services.s3", "AWSSDK.S3", "Amazon.S3", "aws-sdk-s3"]],
	["dynamodb", ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb", "dynamoose", "github.com/aws/aws-sdk-go-v2/service/dynamodb", "software.amazon.awssdk.services.dynamodb", "AWSSDK.DynamoDBv2", "Amazon.DynamoDBv2", "pynamodb"]],
	["kinesis", ["@aws-sdk/client-kinesis", "github.com/aws/aws-sdk-go-v2/service/kinesis", "software.amazon.awssdk.services.kinesis", "AWSSDK.Kinesis"]],
	["eventbridge", ["@aws-sdk/client-eventbridge", "github.com/aws/aws-sdk-go-v2/service/eventbridge", "software.amazon.awssdk.services.eventbridge", "AWSSDK.EventBridge"]],
	["azureblob", ["@azure/storage-blob", "azure.storage.blob", "azure-storage-blob", "github.com/Azure/azure-sdk-for-go/sdk/storage/azblob", "com.azure.storage.blob", "Azure.Storage.Blobs"]],
	["servicebus", ["@azure/service-bus", "azure.servicebus", "azure-servicebus", "github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus", "com.azure.messaging.servicebus", "Azure.Messaging.ServiceBus"]],
	["eventhubs", ["@azure/event-hubs", "azure.eventhub", "azure-eventhub", "github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs", "com.azure.messaging.eventhubs", "Azure.Messaging.EventHubs"]],
	["cosmos", ["@azure/cosmos", "azure.cosmos", "azure-cosmos", "github.com/Azure/azure-sdk-for-go/sdk/data/azcosmos", "com.azure.cosmos", "Microsoft.Azure.Cosmos"]],
	["gcs", ["@google-cloud/storage", "google.cloud.storage", "google-cloud-storage", "cloud.google.com/go/storage", "com.google.cloud.storage", "Google.Cloud.Storage.V1"]],
	["pubsub", ["@google-cloud/pubsub", "google.cloud.pubsub", "google.cloud.pubsub_v1", "google-cloud-pubsub", "cloud.google.com/go/pubsub", "com.google.cloud.pubsub", "Google.Cloud.PubSub.V1"]],
	["firestore", ["@google-cloud/firestore", "firebase-admin", "google.cloud.firestore", "google-cloud-firestore", "cloud.google.com/go/firestore", "com.google.cloud.firestore", "Google.Cloud.Firestore"]],
	["bigquery", ["@google-cloud/bigquery", "google.cloud.bigquery", "google-cloud-bigquery", "cloud.google.com/go/bigquery", "com.google.cloud.bigquery", "Google.Cloud.BigQuery.V2"]],
	["spanner", ["@google-cloud/spanner", "google.cloud.spanner", "google-cloud-spanner", "cloud.google.com/go/spanner"]],
	["elasticsearch", ["@elastic/elasticsearch", "elasticsearch", "@opensearch-project/opensearch", "opensearch-py", "opensearchpy", "github.com/elastic/go-elasticsearch", "co.elastic.clients", "org.elasticsearch", "Elastic.Clients.Elasticsearch", "NEST"]],
	["smtp", ["nodemailer", "smtplib", "net/smtp", "github.com/go-gomail/gomail", "MailKit", "javax.mail", "jakarta.mail"]],
	["grpc", ["@grpc/grpc-js", "grpc", "grpcio", "google.golang.org/grpc", "io.grpc", "Grpc.Net.Client", "Grpc.Core"]],
	["sql", ["sequelize", "typeorm", "knex", "@prisma/client", "prisma", "drizzle-orm", "@mikro-orm/core", "sqlalchemy", "SQLAlchemy", "django.db", "peewee", "tortoise", "databases", "gorm.io/gorm", "github.com/jmoiron/sqlx", "database/sql", "org.hibernate", "jakarta.persistence", "javax.persistence", "org.springframework.data.jpa", "org.springframework.jdbc", "Microsoft.EntityFrameworkCore", "Dapper", "activerecord"]],
];

const LIB_INDEX: Map<string, string> = (() => {
	const m = new Map<string, string>();
	for (const [tech, names] of LIBRARIES) for (const n of names) if (!m.has(n)) m.set(n, tech);
	return m;
})();

/** The technology a package / module / namespace name stands for ("pg", "github.com/lib/pq/xyz", "org.postgresql.Driver"). */
export function libraryTech(name: string): LibraryHit | undefined {
	let n = name.trim();
	for (let guard = 0; n && guard < 12; guard++) {
		const t = LIB_INDEX.get(n);
		if (t) return { tech: TECH[t], name: n };
		const cut = Math.max(n.lastIndexOf("/"), n.lastIndexOf("."), n.lastIndexOf(":"));
		if (cut <= 0) break;
		n = n.slice(0, cut);
	}
	return undefined;
}

/** A checkbox field's value. */
export const isOn = (v: string | undefined) => v === "true" || v === "1" || v === "on" || v === "yes";
