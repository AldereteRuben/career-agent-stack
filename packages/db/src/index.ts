import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const { Pool } = pg;
// A screen opens with about a dozen parallel reads and several panels poll; 5 connections queued them behind each
// other. PostgreSQL allows 100 by default, which leaves room for the launcher, backups and maintenance scripts.
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
export const db = drizzle(pool, { schema });
export * from './schema.js';
