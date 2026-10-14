/**
 * Possible duplicates for imported resume entries (ADR 018). Two entries match when they have the same kind and the
 * same statement after trimming, collapsing whitespace and ignoring case. Matches are only flagged for review.
 */
type ComparableFact = { id: string; kind: string; statement: string };

export function duplicateKey(fact: Pick<ComparableFact, 'kind' | 'statement'>): string {
  return `${fact.kind}\u0000${fact.statement.trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`;
}

/**
 * For each imported entry, the id of an earlier entry it repeats, or null. Existing profile entries are checked first,
 * then earlier entries of the same import, so the first copy in a batch is never flagged against a later one.
 */
export function findDuplicateFacts(imported: readonly ComparableFact[], existing: readonly ComparableFact[]): Array<string | null> {
  const seen = new Map<string, string>();
  for (const fact of existing) if (!seen.has(duplicateKey(fact))) seen.set(duplicateKey(fact), fact.id);
  return imported.map((fact) => {
    const key = duplicateKey(fact);
    const match = seen.get(key) ?? null;
    if (!match) seen.set(key, fact.id);
    return match;
  });
}
