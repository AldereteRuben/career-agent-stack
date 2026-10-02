import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
export const db = drizzle(pool, { schema });
export * from './schema.js';
