const express = require("express");
const { Pool } = require("pg");
const { requireAuth } = require("./auth");

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
app.use(requireAuth);

app.get("/items", async (_req, res) => res.json((await pool.query("select * from items")).rows));
app.post("/items", async (req, res) => res.status(201).json(req.body));

app.listen(8080);
