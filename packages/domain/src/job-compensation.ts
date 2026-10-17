/**
 * Pay stated by a job source (issue #36). It is read from the payload the source returned and shown as stated:
 * no currency conversion, no change of period and no guess when the source says nothing (implementation brief §9).
 */
export const compensationPeriods = ['YEAR', 'MONTH', 'FORTNIGHT', 'WEEK', 'DAY', 'HOUR'] as const;
export type CompensationPeriod = typeof compensationPeriods[number];

export type JobCompensation = {
  min: number | null;
  max: number | null;
  /** ISO 4217 code as the source wrote it, or null when it did not say. */
  currency: string | null;
  period: CompensationPeriod | null;
  /** The source's own wording. Shown on its own when the source gives no numbers (for example Remotive). */
  text: string | null;
};

const maxText = 300;
const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const amount = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const currencyCode = (value: unknown): string | null => (typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : null);
const cleanText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxText) : null;
};

/** Maps the interval words of Lever ("per-year-salary"), Ashby ("1 YEAR") and Himalayas ("annual") to one list. */
export function compensationPeriod(value: unknown): CompensationPeriod | null {
  if (typeof value !== 'string') return null;
  const word = value.toLowerCase();
  if (/fortnight|bi-?week/.test(word)) return 'FORTNIGHT';
  if (/year|annual/.test(word)) return 'YEAR';
  if (/month/.test(word)) return 'MONTH';
  if (/week/.test(word)) return 'WEEK';
  if (/\bday|daily/.test(word)) return 'DAY';
  if (/hour/.test(word)) return 'HOUR';
  return null;
}

function build(min: unknown, max: unknown, currency: unknown, period: unknown, text: unknown): JobCompensation | null {
  let low = amount(min); let high = amount(max);
  // A range that contradicts itself is not shown as numbers; the source's wording, if any, still is.
  if (low !== null && high !== null && low > high) { low = null; high = null; }
  const result: JobCompensation = { min: low, max: high, currency: low === null && high === null ? null : currencyCode(currency), period: low === null && high === null ? null : compensationPeriod(period), text: cleanText(text) };
  return result.min === null && result.max === null && result.text === null ? null : result;
}

/**
 * Reads the pay a source stated in one job's stored payload. Returns null when it stated none. Greenhouse's job list
 * and Arbeitnow do not carry pay, so they always give null; Remotive gives free text only.
 */
export function jobCompensationFromSource(provider: string, payload: unknown): JobCompensation | null {
  const raw = record(payload);
  if (!raw) return null;
  if (provider === 'lever') {
    const range = record(raw.salaryRange);
    return build(range?.min, range?.max, range?.currency, range?.interval, raw.salaryDescriptionPlain);
  }
  if (provider === 'ashby') {
    const compensation = record(raw.compensation);
    const components = Array.isArray(compensation?.summaryComponents) ? compensation.summaryComponents : [];
    const salary = components.map(record).find((component) => component?.compensationType === 'Salary');
    return build(salary?.minValue, salary?.maxValue, salary?.currencyCode, salary?.interval, compensation?.scrapeableCompensationSalarySummary ?? compensation?.compensationTierSummary);
  }
  if (provider === 'himalayas') {
    // Himalayas documents the period as a text with annual as the default; an unknown word is not guessed.
    return build(raw.minSalary, raw.maxSalary, raw.currency, raw.salaryPeriod === undefined || raw.salaryPeriod === null ? 'annual' : raw.salaryPeriod, null);
  }
  if (provider === 'remotive') return build(null, null, null, null, raw.salary);
  return null;
}

/** The first source that stated pay wins; sources are tried in the order given. */
export function firstJobCompensation(sources: Array<{ provider: string; payload: unknown }>): (JobCompensation & { provider: string }) | null {
  for (const source of sources) {
    const compensation = jobCompensationFromSource(source.provider, source.payload);
    if (compensation) return { ...compensation, provider: source.provider };
  }
  return null;
}

const periodWords: Record<CompensationPeriod, { es: string; en: string }> = {
  YEAR: { es: 'al año', en: 'per year' }, MONTH: { es: 'al mes', en: 'per month' }, FORTNIGHT: { es: 'cada dos semanas', en: 'every two weeks' },
  WEEK: { es: 'a la semana', en: 'per week' }, DAY: { es: 'al día', en: 'per day' }, HOUR: { es: 'por hora', en: 'per hour' },
};

/** Text for a person: "€45,000 – €55,000 per year" in the language of the interface. Falls back to the source's own wording. */
export function formatJobCompensation(compensation: JobCompensation, locale: 'es' | 'en'): string {
  const { min, max } = compensation;
  if (min === null && max === null) return compensation.text ?? '';
  const format = (value: number) => {
    const options = { minimumFractionDigits: 0, maximumFractionDigits: 2 };
    try { return new Intl.NumberFormat(locale === 'es' ? 'es-ES' : 'en-GB', compensation.currency ? { ...options, style: 'currency', currency: compensation.currency } : options).format(value); }
    // An unknown currency code is shown as written instead of failing the page.
    catch { return `${new Intl.NumberFormat(locale === 'es' ? 'es-ES' : 'en-GB', options).format(value)} ${compensation.currency ?? ''}`.trim(); }
  };
  const amounts = min !== null && max !== null && min !== max ? `${format(min)} – ${format(max)}` : format((min ?? max) as number);
  const prefix = min !== null && max === null ? (locale === 'es' ? 'Desde ' : 'From ') : min === null && max !== null ? (locale === 'es' ? 'Hasta ' : 'Up to ') : '';
  return `${prefix}${amounts}${compensation.period ? ` ${periodWords[compensation.period][locale]}` : ''}`;
}
