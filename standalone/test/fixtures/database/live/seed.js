// A small shop schema for the live database tests (test/database.test.js with
// MAPPER_DB_LIVE=1): FKs (mandatory, optional, self-referencing, 1:1), a composite
// primary key, a unique column, a view, a second schema, and a read-only user.
// Every statement is safe to run again.

const READER = { user: "mapper_reader", password: "Reader_Pw_5521x" };

const postgres = {
	createDb: "shop",
	// Run in database "shop" as the admin.
	statements: [
		"DROP SCHEMA IF EXISTS billing CASCADE",
		"DROP SCHEMA IF EXISTS auth CASCADE",
		"DROP VIEW IF EXISTS public.order_totals",
		"DROP TABLE IF EXISTS public.order_items, public.orders, public.addresses, public.customer_profiles, public.products, public.customers, public.employees CASCADE",
		"CREATE SCHEMA auth",
		"CREATE TABLE auth.users (id uuid PRIMARY KEY, email text NOT NULL)",
		"CREATE TABLE public.customers (id serial PRIMARY KEY, email varchar(255) NOT NULL UNIQUE, name text NOT NULL, auth_user_id uuid REFERENCES auth.users(id), created_at timestamptz NOT NULL DEFAULT now())",
		"COMMENT ON TABLE public.customers IS 'People who buy things'",
		"CREATE TABLE public.customer_profiles (customer_id int PRIMARY KEY REFERENCES public.customers(id), bio text)",
		"CREATE TABLE public.addresses (id serial PRIMARY KEY, customer_id int NOT NULL REFERENCES public.customers(id), line1 text NOT NULL, city text NOT NULL)",
		"CREATE TABLE public.products (id serial PRIMARY KEY, sku varchar(32) NOT NULL UNIQUE, name text NOT NULL, price numeric(10,2) NOT NULL)",
		"CREATE TABLE public.orders (id bigserial PRIMARY KEY, customer_id int NOT NULL REFERENCES public.customers(id), shipping_address_id int REFERENCES public.addresses(id), status text NOT NULL DEFAULT 'new', placed_at timestamptz)",
		"CREATE INDEX orders_status_idx ON public.orders(status)",
		"CREATE TABLE public.order_items (order_id bigint NOT NULL REFERENCES public.orders(id), product_id int NOT NULL REFERENCES public.products(id), quantity int NOT NULL, PRIMARY KEY (order_id, product_id))",
		"CREATE TABLE public.employees (id serial PRIMARY KEY, name text NOT NULL, manager_id int REFERENCES public.employees(id))",
		"CREATE VIEW public.order_totals AS SELECT o.id AS order_id, sum(oi.quantity * p.price) AS total FROM public.orders o JOIN public.order_items oi ON oi.order_id = o.id JOIN public.products p ON p.id = oi.product_id GROUP BY o.id",
		"CREATE SCHEMA billing",
		"CREATE TABLE billing.invoices (id serial PRIMARY KEY, order_id bigint NOT NULL REFERENCES public.orders(id), amount numeric(12,2) NOT NULL, issued_on date NOT NULL)",
		"INSERT INTO public.customers (email, name) VALUES ('a@example.com', 'Ada'), ('b@example.com', 'Bo')",
		`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READER.user}') THEN CREATE ROLE ${READER.user} LOGIN PASSWORD '${READER.password}'; END IF; END $$`,
		`GRANT USAGE ON SCHEMA public, billing, auth TO ${READER.user}`,
		`GRANT SELECT ON ALL TABLES IN SCHEMA public, billing, auth TO ${READER.user}`,
	],
};

const mysql = {
	statements: [
		"CREATE DATABASE IF NOT EXISTS shop",
		"CREATE DATABASE IF NOT EXISTS shop_billing",
		"DROP VIEW IF EXISTS shop.order_totals",
		"DROP TABLE IF EXISTS shop_billing.invoices, shop.order_items, shop.orders, shop.addresses, shop.customer_profiles, shop.products, shop.customers, shop.employees",
		"CREATE TABLE shop.customers (id int AUTO_INCREMENT PRIMARY KEY, email varchar(255) NOT NULL UNIQUE, name varchar(100) NOT NULL, created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP) COMMENT='People who buy things'",
		"CREATE TABLE shop.customer_profiles (customer_id int PRIMARY KEY, bio text, FOREIGN KEY (customer_id) REFERENCES shop.customers(id))",
		"CREATE TABLE shop.addresses (id int AUTO_INCREMENT PRIMARY KEY, customer_id int NOT NULL, line1 varchar(200) NOT NULL, city varchar(100) NOT NULL, FOREIGN KEY (customer_id) REFERENCES shop.customers(id))",
		"CREATE TABLE shop.products (id int AUTO_INCREMENT PRIMARY KEY, sku varchar(32) NOT NULL UNIQUE, name varchar(200) NOT NULL, price decimal(10,2) NOT NULL)",
		"CREATE TABLE shop.orders (id bigint AUTO_INCREMENT PRIMARY KEY, customer_id int NOT NULL, shipping_address_id int NULL, status varchar(20) NOT NULL DEFAULT 'new', placed_at datetime NULL, INDEX orders_status_idx (status), CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES shop.customers(id), CONSTRAINT fk_orders_address FOREIGN KEY (shipping_address_id) REFERENCES shop.addresses(id))",
		"CREATE TABLE shop.order_items (order_id bigint NOT NULL, product_id int NOT NULL, quantity int NOT NULL, PRIMARY KEY (order_id, product_id), FOREIGN KEY (order_id) REFERENCES shop.orders(id), FOREIGN KEY (product_id) REFERENCES shop.products(id))",
		"CREATE TABLE shop.employees (id int AUTO_INCREMENT PRIMARY KEY, name varchar(100) NOT NULL, manager_id int NULL, FOREIGN KEY (manager_id) REFERENCES shop.employees(id))",
		"CREATE VIEW shop.order_totals AS SELECT o.id AS order_id, SUM(oi.quantity * p.price) AS total FROM shop.orders o JOIN shop.order_items oi ON oi.order_id = o.id JOIN shop.products p ON p.id = oi.product_id GROUP BY o.id",
		"CREATE TABLE shop_billing.invoices (id int AUTO_INCREMENT PRIMARY KEY, order_id bigint NOT NULL, amount decimal(12,2) NOT NULL, FOREIGN KEY (order_id) REFERENCES shop.orders(id))",
		`CREATE USER IF NOT EXISTS '${READER.user}'@'%' IDENTIFIED BY '${READER.password}'`,
		`GRANT SELECT, SHOW VIEW ON shop.* TO '${READER.user}'@'%'`,
		`GRANT SELECT, SHOW VIEW ON shop_billing.* TO '${READER.user}'@'%'`,
	],
};

const mssql = {
	createDb: "shop",
	statements: [
		"IF OBJECT_ID('sales.invoices') IS NOT NULL DROP TABLE sales.invoices",
		"IF OBJECT_ID('dbo.order_totals') IS NOT NULL DROP VIEW dbo.order_totals",
		"IF OBJECT_ID('dbo.order_items') IS NOT NULL DROP TABLE dbo.order_items",
		"IF OBJECT_ID('dbo.orders') IS NOT NULL DROP TABLE dbo.orders",
		"IF OBJECT_ID('dbo.addresses') IS NOT NULL DROP TABLE dbo.addresses",
		"IF OBJECT_ID('dbo.customer_profiles') IS NOT NULL DROP TABLE dbo.customer_profiles",
		"IF OBJECT_ID('dbo.products') IS NOT NULL DROP TABLE dbo.products",
		"IF OBJECT_ID('dbo.employees') IS NOT NULL DROP TABLE dbo.employees",
		"IF OBJECT_ID('dbo.customers') IS NOT NULL DROP TABLE dbo.customers",
		"IF SCHEMA_ID('sales') IS NULL EXEC('CREATE SCHEMA sales')",
		"CREATE TABLE dbo.customers (id int IDENTITY PRIMARY KEY, email nvarchar(255) NOT NULL UNIQUE, name nvarchar(100) NOT NULL, created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME())",
		"CREATE TABLE dbo.customer_profiles (customer_id int PRIMARY KEY REFERENCES dbo.customers(id), bio nvarchar(max))",
		"CREATE TABLE dbo.addresses (id int IDENTITY PRIMARY KEY, customer_id int NOT NULL REFERENCES dbo.customers(id), line1 nvarchar(200) NOT NULL, city nvarchar(100) NOT NULL)",
		"CREATE TABLE dbo.products (id int IDENTITY PRIMARY KEY, sku varchar(32) NOT NULL UNIQUE, name nvarchar(200) NOT NULL, price decimal(10,2) NOT NULL)",
		"CREATE TABLE dbo.orders (id bigint IDENTITY PRIMARY KEY, customer_id int NOT NULL REFERENCES dbo.customers(id), shipping_address_id int NULL REFERENCES dbo.addresses(id), status varchar(20) NOT NULL DEFAULT 'new', placed_at datetime2 NULL)",
		"CREATE INDEX orders_status_idx ON dbo.orders(status)",
		"CREATE TABLE dbo.order_items (order_id bigint NOT NULL REFERENCES dbo.orders(id), product_id int NOT NULL REFERENCES dbo.products(id), quantity int NOT NULL, PRIMARY KEY (order_id, product_id))",
		"CREATE TABLE dbo.employees (id int IDENTITY PRIMARY KEY, name nvarchar(100) NOT NULL, manager_id int NULL REFERENCES dbo.employees(id))",
		"EXEC('CREATE VIEW dbo.order_totals AS SELECT o.id AS order_id, SUM(oi.quantity * p.price) AS total FROM dbo.orders o JOIN dbo.order_items oi ON oi.order_id = o.id JOIN dbo.products p ON p.id = oi.product_id GROUP BY o.id')",
		"CREATE TABLE sales.invoices (id int IDENTITY PRIMARY KEY, order_id bigint NOT NULL REFERENCES dbo.orders(id), amount decimal(12,2) NOT NULL)",
		`IF SUSER_ID('${READER.user}') IS NULL CREATE LOGIN ${READER.user} WITH PASSWORD = '${READER.password}', CHECK_POLICY = OFF`,
		`IF USER_ID('${READER.user}') IS NULL CREATE USER ${READER.user} FOR LOGIN ${READER.user}`,
		`ALTER ROLE db_datareader ADD MEMBER ${READER.user}`,
		`GRANT VIEW DEFINITION TO ${READER.user}`,
	],
};

// Run as the app user SHOP (created by the gvenzl image).
const oracle = {
	statements: [
		"BEGIN FOR t IN (SELECT table_name FROM user_tables) LOOP EXECUTE IMMEDIATE 'DROP TABLE \"' || t.table_name || '\" CASCADE CONSTRAINTS PURGE'; END LOOP; FOR v IN (SELECT view_name FROM user_views) LOOP EXECUTE IMMEDIATE 'DROP VIEW \"' || v.view_name || '\"'; END LOOP; END;",
		"CREATE TABLE customers (id NUMBER(10) GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, email VARCHAR2(255 CHAR) NOT NULL UNIQUE, name VARCHAR2(100) NOT NULL, created_at TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL)",
		"COMMENT ON TABLE customers IS 'People who buy things'",
		"CREATE TABLE customer_profiles (customer_id NUMBER(10) PRIMARY KEY REFERENCES customers(id), bio CLOB)",
		"CREATE TABLE addresses (id NUMBER(10) PRIMARY KEY, customer_id NUMBER(10) NOT NULL REFERENCES customers(id), line1 VARCHAR2(200) NOT NULL, city VARCHAR2(100) NOT NULL)",
		"CREATE TABLE products (id NUMBER(10) PRIMARY KEY, sku VARCHAR2(32) NOT NULL UNIQUE, name VARCHAR2(200) NOT NULL, price NUMBER(10,2) NOT NULL)",
		"CREATE TABLE orders (id NUMBER(19) PRIMARY KEY, customer_id NUMBER(10) NOT NULL REFERENCES customers(id), shipping_address_id NUMBER(10) REFERENCES addresses(id), status VARCHAR2(20) DEFAULT 'new' NOT NULL, placed_at DATE)",
		"CREATE INDEX orders_status_idx ON orders(status)",
		"CREATE TABLE order_items (order_id NUMBER(19) NOT NULL REFERENCES orders(id), product_id NUMBER(10) NOT NULL REFERENCES products(id), quantity NUMBER(5) NOT NULL, CONSTRAINT order_items_pk PRIMARY KEY (order_id, product_id))",
		"CREATE TABLE employees (id NUMBER(10) PRIMARY KEY, name VARCHAR2(100) NOT NULL, manager_id NUMBER(10) REFERENCES employees(id))",
		"CREATE VIEW order_totals AS SELECT o.id AS order_id, SUM(oi.quantity * p.price) AS total FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id GROUP BY o.id",
	],
};

/** Seeds MongoDB database "shop" (admin client) and creates a read-only user. */
async function mongo(client, { ObjectId, DBRef }) {
	const db = client.db("shop");
	await db.dropDatabase();
	const customers = [new ObjectId(), new ObjectId(), new ObjectId()];
	const products = [new ObjectId(), new ObjectId()];
	await db.collection("customers").insertMany(
		customers.map((_id, i) => ({ _id, email: `c${i}@example.com`, name: `Customer ${i}`, address: { city: "Berlin", zip: "10115" }, ...(i ? { vip: true } : {}) }))
	);
	await db.collection("customers").createIndex({ email: 1 }, { unique: true });
	await db.collection("products").insertMany(products.map((_id, i) => ({ _id, sku: `SKU-${i}`, name: `Product ${i}`, price: 9.5 + i, tags: ["a", "b"] })));
	const orders = [];
	for (let i = 0; i < 6; i++) {
		orders.push({ _id: new ObjectId(), customerId: customers[i % 3], status: i % 2 ? "paid" : "new", items: [{ productId: products[i % 2], qty: i + 1 }], placedAt: new Date(), ...(i % 3 === 0 ? { couponCode: "X" } : {}) });
	}
	await db.collection("orders").insertMany(orders);
	await db.collection("orders").createIndex({ customerId: 1 });
	await db.collection("payments").insertMany(orders.slice(0, 3).map((o) => ({ order: new DBRef("orders", o._id), amount: 10, method: "card" })));
	await db.collection("reviews").insertMany([{ customer: customers[0], product_id: products[1], stars: 5, text: "ok" }]);
	await db.createCollection("big_orders", { viewOn: "orders", pipeline: [{ $match: { status: "paid" } }, { $project: { customerId: 1 } }] });
	try {
		await db.command({ dropUser: READER.user });
	} catch {
		// not there yet
	}
	await db.command({ createUser: READER.user, pwd: READER.password, roles: [{ role: "read", db: "shop" }] });
}

module.exports = { READER, postgres, mysql, mssql, oracle, mongo };
