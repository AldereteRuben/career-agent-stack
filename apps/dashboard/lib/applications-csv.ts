import { instantToLocalDateTime } from '@career/domain';
import { labelFor } from './labels';
import type { Locale } from './locale';

export type CsvApplication = {
  id?: string;
  role: string; company: string; location: string | null; canonicalUrl: string | null; state: string; recruitmentStage: string;
  createdAt?: string | null; updatedAt: string; nextStep?: string | null; followUpDate?: string | null; interviewAt?: string | null;
  interviewTimezone?: string | null; notes?: string | null;
};

export type CsvSeparator = ',' | ';';

/**
 * Excel splits columns on the list separator of the computer's regional format: a semicolon where the decimal mark is a
 * comma (Spain, Argentina, Germany) and a comma elsewhere (Mexico, the United States). The language of the interface
 * says nothing about it, so the regional format of the browser decides.
 */
export const defaultCsvSeparator = (region?: string): CsvSeparator => {
  try { return new Intl.NumberFormat(region).format(1.1).includes(',') ? ';' : ','; } catch { return ','; }
};

/**
 * One CSV cell. Text a spreadsheet would run as a formula (it starts with =, +, -, @, a tab or a carriage return,
 * after any whitespace) gets a leading apostrophe so it shows as text; then the separator, quotes and line breaks are quoted.
 */
export function csvCell(value: unknown, separator: CsvSeparator = ','): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^\s*[=+\-@]|^ *[\t\r\n]/.test(text)) text = `'${text}`;
  return text.includes(separator) || /["\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** An instant as "2026-10-01 10:00" in the given zone, the shape of the interview, so a spreadsheet reads it as a date. */
function localMoment(instant: string | null | undefined, timeZone: string): string {
  if (!instant) return '';
  const local = instantToLocalDateTime(instant, timeZone);
  return local ? local.replace('T', ' ') : instant;
}

const headers: Record<'role' | 'company' | 'location' | 'link' | 'state' | 'stage' | 'created' | 'updated' | 'nextStep' | 'followUp' | 'interview' | 'notes', { es: string; en: string }> = {
  role: { es: 'Puesto', en: 'Role' }, company: { es: 'Empresa', en: 'Company' }, location: { es: 'Ubicación', en: 'Location' }, link: { es: 'Enlace', en: 'Link' },
  state: { es: 'Estado', en: 'Status' }, stage: { es: 'Etapa', en: 'Stage' }, created: { es: 'Creada', en: 'Created' }, updated: { es: 'Última actualización', en: 'Last updated' },
  nextStep: { es: 'Próximo paso', en: 'Next step' }, followUp: { es: 'Fecha del próximo paso', en: 'Next step date' }, interview: { es: 'Entrevista', en: 'Interview' }, notes: { es: 'Notas', en: 'Notes' },
};

const byteOrderMark = String.fromCharCode(0xFEFF);

/**
 * UTF-8 with a byte-order mark so Excel shows accents correctly; CRLF line endings as RFC 4180 asks. Notes are opt-in.
 * "Created" and "Last updated" are written like the interview, in the person's time zone (the browser's by default).
 */
export function applicationsCsv(rows: CsvApplication[], locale: Locale, { includeNotes = false, separator = defaultCsvSeparator(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone }: { includeNotes?: boolean; separator?: CsvSeparator; timeZone?: string } = {}): string {
  const keys = ['role', 'company', 'location', 'link', 'state', 'stage', 'created', 'updated', 'nextStep', 'followUp', 'interview', ...(includeNotes ? ['notes' as const] : [])] as const;
  const lines = [keys.map((key) => csvCell(headers[key][locale], separator)).join(separator)];
  for (const row of rows) {
    const local = row.interviewAt && row.interviewTimezone ? instantToLocalDateTime(row.interviewAt, row.interviewTimezone) : '';
    const interview = local ? `${local.replace('T', ' ')} (${row.interviewTimezone})` : row.interviewAt ?? '';
    const cells: Record<typeof keys[number], unknown> = {
      role: row.role, company: row.company, location: row.location, link: row.canonicalUrl,
      state: labelFor.applicationState(row.state, locale), stage: labelFor.recruitmentStage(row.recruitmentStage, locale),
      created: localMoment(row.createdAt, timeZone), updated: localMoment(row.updatedAt, timeZone), nextStep: row.nextStep, followUp: row.followUpDate, interview, notes: row.notes,
    };
    lines.push(keys.map((key) => csvCell(cells[key], separator)).join(separator));
  }
  return `${byteOrderMark}${lines.join('\r\n')}\r\n`;
}
