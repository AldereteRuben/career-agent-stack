import { createHash } from 'node:crypto';

/** Strip only known tracking parameters. Requisition IDs and all other query values remain part of identity. */
export function identityUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_JOB_URL');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || ['gclid', 'fbclid'].includes(key.toLowerCase())) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.toString();
}
export function jobIdentity(value: string): string { return createHash('sha256').update(identityUrl(value)).digest('hex'); }

import { db } from '@career/db';
import { sql } from 'drizzle-orm';
type Executor = Pick<typeof db, 'execute'>;
export async function lockJobIdentity(tx: Executor, workspaceId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`job-identity:${workspaceId}`},0))`);
}
export async function findJobIdentity(tx: Executor, workspaceId: string, url: string): Promise<string | null> {
  const normalized = identityUrl(url); const key = jobIdentity(normalized);
  const result = await tx.execute(sql`SELECT j.id FROM jobs j LEFT JOIN job_identity_members m ON m.workspace_id=j.workspace_id AND m.job_id=j.id
    WHERE j.workspace_id=${workspaceId} AND (m.identity_key=${key} OR j.canonical_url=${normalized} OR j.canonical_url=${url}) ORDER BY j.created_at,j.id LIMIT 1`);
  return result.rows[0]?.id as string | undefined ?? null;
}
export async function bindJobIdentity(tx: Executor, workspaceId: string, jobId: string, url: string) {
  const normalized=identityUrl(url);
  await tx.execute(sql`INSERT INTO job_identity_members(workspace_id,job_id,identity_key,evidence)
    VALUES(${workspaceId},${jobId},${jobIdentity(normalized)},${JSON.stringify({type:'canonical-url',url:normalized})}::jsonb) ON CONFLICT DO NOTHING`);
}
