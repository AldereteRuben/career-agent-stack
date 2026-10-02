import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });
export default defineConfig({ schema: './src/schema.ts', out: './migrations', dialect: 'postgresql', dbCredentials: { url: process.env.DATABASE_URL ?? '' }, strict: true, verbose: true });
