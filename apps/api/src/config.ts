import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.literal('127.0.0.1').default('127.0.0.1'), API_PORT: z.coerce.number().int().min(1).max(65535).default(3001), WEB_ORIGIN: z.string().url().default('http://127.0.0.1:3000'),
  DATABASE_URL: z.string().url(), APP_ENCRYPTION_KEY: z.string().min(32), APP_SESSION_SECRET: z.string().min(32),
  FILES_LOCAL_PATH: z.string().default('./data/files'), DATA_LOCAL_PATH: z.string().default('./data'), AI_PROVIDER: z.literal('none').default('none'),
}).passthrough();

const result = configSchema.safeParse(process.env);
if (!result.success) {
  console.error('Invalid configuration:', result.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; '));
  process.exit(1);
}
export const config = { ...result.data, FILES_LOCAL_PATH: resolve(projectRoot, result.data.FILES_LOCAL_PATH), DATA_LOCAL_PATH: resolve(projectRoot, result.data.DATA_LOCAL_PATH) };
