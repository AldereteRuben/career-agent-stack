type FixturePool = {
  on(event: 'connect' | 'remove', listener: (client: unknown) => void): unknown;
  off(event: 'connect' | 'remove', listener: (client: unknown) => void): unknown;
  end(): Promise<void>;
};

/** Attach before the first query. pg-pool may resolve end() before its client.end callbacks emit remove. */
export function trackPgPoolCleanup(pool: FixturePool): () => Promise<void> {
  const clients = new Set<unknown>();
  let emptied: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const connected = (client: unknown) => { clients.add(client); };
  const removed = (client: unknown) => { clients.delete(client); if (!clients.size) emptied?.(); };
  pool.on('connect', connected);
  pool.on('remove', removed);
  return () => closing ??= (async () => {
    try {
      await pool.end();
      if (clients.size) await new Promise<void>(resolve => { emptied = resolve; });
    } finally {
      pool.off('connect', connected);
      pool.off('remove', removed);
    }
  })();
}
