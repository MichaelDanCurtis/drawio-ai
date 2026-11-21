import { Pool } from "pg";
import Redis from "ioredis";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const cache = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
