/**
 * Splits the browser scenarios across CI jobs. Each job runs its own isolated stack, so the request pacing and the
 * API rate limit apply per shard. `E2E_SHARD=2/4` runs the second of four slices; empty or unset runs everything.
 */
export type Shard = { index: number; count: number };

export function parseShard(value: string | undefined): Shard | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  const match = /^(\d+)\/(\d+)$/u.exec(text);
  const index = match ? Number(match[1]) : 0;
  const count = match ? Number(match[2]) : 0;
  if (!match || count < 1 || index < 1 || index > count) throw new Error(`E2E_SHARD must look like "2/4" (slice 2 of 4), got "${text}".`);
  return { index, count };
}

/** Every `count`-th scenario starting at `index`, in the original order. `always` scenarios run in every shard. */
export function selectShard<T extends { name: string }>(scenarios: readonly T[], shard: Shard | null, always: readonly string[]): T[] {
  if (!shard) return [...scenarios];
  const rest = scenarios.filter((scenario) => !always.includes(scenario.name));
  const mine = new Set(rest.filter((_, position) => position % shard.count === shard.index - 1));
  return scenarios.filter((scenario) => always.includes(scenario.name) || mine.has(scenario));
}
