from pydantic import BaseModel


class Item(BaseModel):
    sku: str
    stock: int


class Reservation(BaseModel):
    items: list[Item]
    order_id: str
