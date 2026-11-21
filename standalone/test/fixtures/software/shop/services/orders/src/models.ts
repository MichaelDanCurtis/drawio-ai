import type { Pool } from "pg";

export interface Entity {
	id: string;
}

export enum OrderStatus {
	Pending,
	Paid,
	Cancelled,
}

export class OrderItem {
	sku: string;
	quantity: number;
}

export class Order implements Entity {
	id: string;
	status: OrderStatus;
	items: OrderItem[];
}

export abstract class Repository<T extends Entity> {
	constructor(protected pool: Pool) {}
	abstract find(id: string): Promise<T>;
}

export class OrderRepository extends Repository<Order> {
	async find(id: string): Promise<Order> {
		return (await this.pool.query("select * from orders where id = $1", [id])).rows[0];
	}
	async list(): Promise<Order[]> {
		return [];
	}
	async create(body: unknown): Promise<Order> {
		return body as Order;
	}
	async cancel(id: string): Promise<Order> {
		return this.find(id);
	}
}
