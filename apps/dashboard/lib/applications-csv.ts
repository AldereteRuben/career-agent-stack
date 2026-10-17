import { instantToLocalDateTime } from '@career/domain';
import { labelFor } from './labels';
import type { Locale } from './locale';

export type CsvApplication = {
  role: string; company: string; location: string | null; canonicalUrl: string | null; state: string; recruitmentStage: string;
  createdAt?: string | null; updatedAt: string; nextStep?: string | null; followUpDate?: string | null; interviewAt?: string | null;
  interviewTimezone?: string | null; notes?: string | null;
};

/**
 * One CSV cell. Text a spreadsheet would run as a formula (it starts with =, +, -, @, a tab or a carriage return,
 * after any spaces) gets a leading apostrophe so it shows as text; then commas, quotes and line breaks are quoted.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[ ]*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const headers: Record<'role' | 'company' | 'location' | 'link' | 'state' | 'stage' | 'created' | 'updated' | 'nextStep' | 'followUp' | 'interview' | 'notes', { es: string; en: string }> = {
  role: { es: 'Puesto', en: 'Role' }, company: { es: 'Empresa', en: 'Company' }, location: { es: 'Ubicación', en: 'Location' }, link: { es: 'Enlace', en: 'Link' },
  state: { es: 'Estado', en: 'Status' }, stage: { es: 'Etapa', en: 'Stage' }, created: { es: 'Creada', en: 'Created' }, updated: { es: 'Última actualización', en: 'Last updated' },
  nextStep: { es: 'Próximo paso', en: 'Next step' }, followUp: { es: 'Fecha del próximo paso', en: 'Next step date' }, interview: { es: 'Entrevista', en: 'Interview' }, notes: { es: 'Notas', en: 'Notes' },
};

const byteOrderMark = String.fromCharCode(0xFEFF);

/** UTF-8 with a byte-order mark so Excel shows accents correctly; CRLF line endings as RFC 4180 asks. Notes are opt-in. */
export function applicationsCsv(rows: CsvApplication[], locale: Locale, { includeNotes = false }: { includeNotes?: boolean } = {}): string {
  const keys = ['role', 'company', 'location', 'link', 'state', 'stage', 'created', 'updated', 'nextStep', 'followUp', 'interview', ...(includeNotes ? ['notes' as const] : [])] as const;
  const lines = [keys.map((key) => csvCell(headers[key][locale])).join(',')];
  for (const row of rows) {
    const local = row.interviewAt && row.interviewTimezone ? instantToLocalDateTime(row.interviewAt, row.interviewTimezone) : '';
    const interview = local ? `${local.replace('T', ' ')} (${row.interviewTimezone})` : row.interviewAt ?? '';
    const cells: Record<typeof keys[number], unknown> = {
      role: row.role, company: row.company, location: row.location, link: row.canonicalUrl,
      state: labelFor.applicationState(row.state, locale), stage: labelFor.recruitmentStage(row.recruitmentStage, locale),
      created: row.createdAt, updated: row.updatedAt, nextStep: row.nextStep, followUp: row.followUpDate, interview, notes: row.notes,
    };
    lines.push(keys.map((key) => csvCell(cells[key])).join(','));
  }
  return `${byteOrderMark}${lines.join('\r\n')}\r\n`;
}
