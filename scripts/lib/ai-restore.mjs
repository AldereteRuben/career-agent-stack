// Invoked only inside the transaction that sanitizes a newly created restore database.
// Preserve row counts, approved historical documents and provenance; never restore executable permissions.
import { hasTable } from './backup-core.mjs';

export async function disconnectRestoredAi(client, tableExists = hasTable) {
  const counts = { connections: 0, consents: 0, policies: 0, runs: 0 };
  if (await tableExists(client, 'public.ai_connections')) {
    counts.connections = (await client.query("update ai_connections set active=false,state='UNAVAILABLE',official_context_ref=NULL,revision=revision+1,updated_at=now() where active or official_context_ref is not null or state <> 'UNAVAILABLE'")).rowCount;
  }
  if (await tableExists(client, 'public.ai_consents')) {
    counts.consents = (await client.query('update ai_consents set revoked_at=now() where revoked_at is null')).rowCount;
  }
  if (await tableExists(client, 'public.ai_automation_policies')) {
    counts.policies = (await client.query('update ai_automation_policies set active=false,paused=true,revision=revision+1,updated_at=now() where active or not paused')).rowCount;
  }
  if (await tableExists(client, 'public.ai_runs')) {
    counts.runs = (await client.query(`update ai_runs set
      status=case when status='QUEUED' then 'CANCELLED' else 'INTERRUPTED' end,
      error=jsonb_build_object('code','CONSENT_REVOKED','dispatched',case when status='QUEUED' then 'NO' else 'UNKNOWN' end),
      completed_at=now(),lease_token=NULL,lease_owner=NULL,lease_until=NULL
      where status in ('QUEUED','RUNNING','CANCEL_REQUESTED')`)).rowCount;
  }
  if (await tableExists(client, 'public.ai_account_leases')) {
    await client.query('update ai_account_leases set run_id=NULL,workspace_id=NULL,lease_token=NULL,lease_owner=NULL,lease_until=now()');
  }
  if (await tableExists(client, 'public.ai_daily_budgets')) {
    await client.query('update ai_daily_budgets set automatic_reserved=0,manual_reserved=0,updated_at=now()');
  }
  if (await tableExists(client, 'public.ai_usage_snapshots')) {
    await client.query("update ai_usage_snapshots set availability='UNAVAILABLE',windows='[]'::jsonb,source='NONE'");
  }
  return counts;
}
