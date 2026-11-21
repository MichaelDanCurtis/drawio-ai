import os
from fastapi import FastAPI
from pymongo import MongoClient
from kafka import KafkaConsumer

from .models import Item, Reservation

app = FastAPI()
client = MongoClient(os.environ["MONGO_URL"])
consumer = KafkaConsumer("order-created", bootstrap_servers=os.getenv("KAFKA_BOOTSTRAP_SERVERS"))


@app.get("/items/{sku}")
def get_item(sku: str) -> Item:
    return client.inventory.items.find_one({"sku": sku})


@app.post("/reserve")
def reserve(r: Reservation):
    return {"ok": True}
