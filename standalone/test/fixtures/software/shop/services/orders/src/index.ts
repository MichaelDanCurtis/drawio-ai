import express from "express";
import axios from "axios";
import { Kafka } from "kafkajs";
import { pool } from "./db";
import { Order, OrderRepository } from "./models";

const app = express();
const kafka = new Kafka({ brokers: (process.env.KAFKA_BROKERS ?? "").split(",") });
const producer = kafka.producer();
const inventory = axios.create({ baseURL: process.env.INVENTORY_URL });
const repo = new OrderRepository(pool);

app.get("/orders", async (_req, res) => res.json(await repo.list()));
app.get("/orders/:id", async (req, res) => res.json(await repo.find(req.params.id)));
app.post("/orders", async (req, res) => {
	const order: Order = await repo.create(req.body);
	await inventory.post("/reserve", { items: order.items });
	await fetch("https://api.stripe.com/v1/charges", { method: "POST" });
	await producer.send({ topic: "order-created", messages: [{ value: JSON.stringify(order) }] });
	res.status(201).json(order);
});
app.delete("/orders/:id", async (req, res) => res.json(await repo.cancel(req.params.id)));

app.listen(8080);
