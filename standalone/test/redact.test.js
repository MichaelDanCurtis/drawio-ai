// Credentials never reach map records or remembered Mapper inputs.
// Run from standalone/: node --test test/redact.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/ts");
const { redactCredentials, safeInputs } = require("../src/main/mapper/redact");
const store = require("../src/main/mapper/store");

test("URL user info, secret query parameters and connection-string passwords are stripped", () => {
	assert.equal(redactCredentials("https://user:password@tracking.example.com/mlflow"), "https://tracking.example.com/mlflow");
	assert.equal(redactCredentials("https://ghp_TOKEN123@github.com/org/repo.git"), "https://github.com/org/repo.git");
	assert.equal(redactCredentials("postgres://app:s3cret@db.internal:5432/shop"), "postgres://db.internal:5432/shop");
	assert.equal(redactCredentials("https://acct.blob.core.windows.net/c?sv=2022&sig=abc%2Bdef&se=2026"), "https://acct.blob.core.windows.net/c?sv=2022&sig=REDACTED&se=2026");
	assert.equal(redactCredentials("https://api.example.com/v1?api_key=xyz&page=2"), "https://api.example.com/v1?api_key=REDACTED&page=2");
	assert.equal(redactCredentials("Server=db;Database=shop;User Id=sa;Password=Hunter2!;Encrypt=true"), "Server=db;Database=shop;User Id=sa;Password=REDACTED;Encrypt=true");
	assert.equal(redactCredentials("http://localhost:5000"), "http://localhost:5000");
	assert.equal(redactCredentials("/Users/me/project/mlruns"), "/Users/me/project/mlruns");
	assert.equal(redactCredentials("us-east-1"), "us-east-1");
});

test("safeInputs drops secret fields and strips credentials from the rest", () => {
	assert.deepEqual(safeInputs({ trackingUri: "https://u:p@h.example", token: "t0k", folder: "/repo" }, new Set(["token"])), { trackingUri: "https://h.example", folder: "/repo" });
});

test("a map record never stores credentials from a text field (MLflow tracking URI)", () => {
	const recipe = { id: "ml.mlflow", title: "MLflow", category: "ml", description: "", mode: "inventory", fields: [{ id: "trackingUri", label: "Tracking URI", type: "text" }, { id: "token", label: "Token", type: "password" }] };
	const r = store.createRecord({ recipe, input: { trackingUri: "https://user:password@tracking.example.com", token: "abc" }, result: { graph: { title: "MLflow", nodes: [], edges: [] }, facts: "", summary: "" } });
	assert.deepEqual(r.input, { trackingUri: "https://tracking.example.com" });
	assert.doesNotMatch(JSON.stringify(r), /password|abc/);
});
