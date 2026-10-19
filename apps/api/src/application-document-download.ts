type ApplicationDocumentDownloadNameInput = {
  applicationId: string;
  company: string | null;
  role: string | null;
  kind: 'RESUME' | 'COVER_LETTER';
  language: 'es' | 'en';
  revision: number;
  format: 'text' | 'pdf';
};

/** Produces an ASCII-only, header-safe filename that identifies the application and draft. */
export function applicationDocumentDownloadFileName(input: ApplicationDocumentDownloadNameInput) {
  const application = [input.company, input.role]
    .filter((part): part is string => Boolean(part?.trim()))
    .map(safeFilenamePart)
    .filter(Boolean)
    .join('-') || 'application';
  const kind = input.kind === 'COVER_LETTER' ? 'cover-letter' : 'resume';
  const extension = input.format === 'pdf' ? 'pdf' : 'txt';
  return `${application}-${kind}-${input.language}-r${input.revision}-${input.applicationId.slice(0, 8)}.${extension}`;
}

function safeFilenamePart(value: string) {
  return value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32)
    .replace(/-+$/gu, '');
}
