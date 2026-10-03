export type StructuredEntry = {
  type: 'employment' | 'education'; title: string; organization: string;
  startMonth: string; endMonth?: string; current: boolean;
  description: string; locale: 'es' | 'en';
};

export function entryStatement(entry: StructuredEntry, locale = entry.locale): string {
  const month = (value: string) => `${value.slice(5)}/${value.slice(0, 4)}`;
  const present = entry.type === 'education' ? (locale === 'es' ? 'En curso' : 'In progress') : (locale === 'es' ? 'Actualidad' : 'Present');
  return [`${entry.title} · ${entry.organization}`, `${month(entry.startMonth)} - ${entry.current ? present : month(entry.endMonth!)}`, entry.description].filter(Boolean).join('\n');
}

/** Recover only the exact employment format emitted by 0.3.1. Never infer dates or split arbitrary prose. */
export function legacyEmployment(kind: string, statement: string): StructuredEntry | null {
  if (kind !== 'experience') return null;
  const match = /^([^\n·]+) · ([^\n·]+)\n(0[1-9]|1[0-2])\/([1-9][0-9]{3}) - (?:(0[1-9]|1[0-2])\/([1-9][0-9]{3})|(Actualidad|Present))\n([\s\S]+)$/.exec(statement);
  if (!match || match[1]!.length > 200 || match[2]!.length > 200) return null;
  const startMonth = `${match[4]}-${match[3]}`;
  const endMonth = match[7] ? undefined : `${match[6]}-${match[5]}`;
  if (endMonth && endMonth < startMonth) return null;
  return { type: 'employment', title: match[1]!, organization: match[2]!, startMonth, ...(endMonth ? { endMonth } : {}), current: Boolean(match[7]), description: match[8]!, locale: match[7] === 'Present' ? 'en' : 'es' };
}

export type PrintableFact = { kind: string; statement: string; details?: StructuredEntry | null };

/** The exact text the resume renderer prints for a fact in a PDF language: structured entries are formatted, plain text is kept verbatim. */
export function printedStatement(fact: PrintableFact, language: 'es' | 'en'): string {
  const entry = fact.details ?? legacyEmployment(fact.kind, fact.statement);
  return entry ? entryStatement(entry, language) : fact.statement;
}
