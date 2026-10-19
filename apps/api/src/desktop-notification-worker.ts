import { pool } from '@career/db';
import { checkNativeNotificationAvailability, sendNativeAlert } from './native-notifications.js';
import { notificationText } from './desktop-notification-copy.js';

type QueuedAlert = { id: string; workspace_id: string; new_count: number; language: 'en' | 'es' };
type NotificationClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  release: () => void;
};
type WorkerDependencies = {
  available?: typeof checkNativeNotificationAvailability;
  send?: typeof sendNativeAlert;
};

async function claimAlert(): Promise<QueuedAlert | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = (await client.query<QueuedAlert>(`SELECT e.id,e.workspace_id,e.new_count,e.language
      FROM desktop_notification_events e JOIN desktop_notification_settings s ON s.workspace_id=e.workspace_id
      WHERE s.enabled AND (e.status='PENDING' OR (e.status='SENDING' AND e.lease_until<now()))
      ORDER BY e.created_at,e.id FOR UPDATE OF e SKIP LOCKED LIMIT 1`)).rows[0];
    if (!event) { await client.query('COMMIT'); return null; }
    await client.query(`UPDATE desktop_notification_events SET status='SENDING',attempts=attempts+1,lease_until=now()+interval '2 minutes',last_error=NULL WHERE id=$1`, [event.id]);
    await client.query('COMMIT');
    return event;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function finishAlert(client: NotificationClient, event: QueuedAlert, status: 'SENT' | 'FAILED' | 'DISABLED', error: string | null = null): Promise<void> {
  const updated = await client.query(`UPDATE desktop_notification_events SET status=$2,lease_until=NULL,last_error=$3,delivered_at=CASE WHEN $4 THEN now() ELSE delivered_at END WHERE id=$1 AND status='SENDING'`, [event.id,status,error,status === 'SENT']);
  if (!updated.rowCount) return;
  if (status === 'SENT' || status === 'FAILED') {
    await client.query(`UPDATE desktop_notification_settings SET last_status=$2,last_attempt_at=now(),updated_at=now() WHERE workspace_id=$1`, [event.workspace_id,status === 'SENT' ? 'ACCEPTED' : 'FAILED']);
  }
}

export async function deliverOneDesktopNotification(dependencies: WorkerDependencies = {}): Promise<boolean> {
  const available = dependencies.available ?? checkNativeNotificationAvailability;
  const send = dependencies.send ?? sendNativeAlert;
  const event = await claimAlert();
  if (!event) return false;
  const client = await pool.connect();
  const lock = `desktop-notifications:${event.workspace_id}`;
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lock]); locked = true;
    const current = (await client.query(`SELECT e.status,s.enabled FROM desktop_notification_events e
      JOIN desktop_notification_settings s ON s.workspace_id=e.workspace_id WHERE e.id=$1`, [event.id])).rows[0];
    if (current?.status !== 'SENDING' || !current.enabled) { await finishAlert(client,event,'DISABLED'); return true; }
    if (!(await available())) { await finishAlert(client,event,'FAILED','NATIVE_NOTIFICATIONS_UNAVAILABLE'); return true; }
    const alert = { title: 'Career Stack', message: notificationText(event.language,event.new_count), language: event.language };
    try { await send(alert); await finishAlert(client,event,'SENT'); }
    catch { await finishAlert(client,event,'FAILED','NATIVE_SEND_FAILED'); }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]).catch(() => {});
    client.release();
  }
  return true;
}

/** Polls separately from job search so a notification action can wait without pausing source reads. */
export function startDesktopNotificationWorker(onError: (error: unknown) => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let current: Promise<void> = Promise.resolve();
  const tick = () => {
    current = deliverOneDesktopNotification().then(() => undefined).catch(onError).finally(() => {
      if (!stopped) { timer = setTimeout(tick, 5_000); timer.unref(); }
    });
  };
  timer = setTimeout(tick, 1_000); timer.unref();
  return async () => { stopped = true; clearTimeout(timer); await current; };
}
