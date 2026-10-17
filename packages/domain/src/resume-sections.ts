/**
 * Resume import without AI (ADR 018, task T4). Pure and run in the browser next to the extracted text, which never
 * leaves it: the text is split into Spanish or English sections, month-year date ranges are read, and each section
 * becomes editable proposals. Nothing is guessed: a missing or ambiguous date is left empty for the person to complete,
 * and sections the profile cannot hold are reported as skipped instead of being stored under another kind.
 */
import { factSchema, maxImportedFacts } from './contracts.js';

export type ResumeLocale = 'es' | 'en';
export type ResumeSectionKind = 'summary' | 'experience' | 'education' | 'skills' | 'languages' | 'certifications' | 'projects' | 'achievements' | 'other';
export type ResumeProposalKind = 'summary' | 'experience' | 'education' | 'skill_evidence' | 'language' | 'certification' | 'project' | 'achievement';
/** Why a proposal needs attention. MISSING_DATES and AMBIGUOUS_DATES keep it as plain text until the person adds the dates. */
export type ResumeIssue = 'MISSING_DATES' | 'AMBIGUOUS_DATES' | 'MISSING_ORGANIZATION' | 'SPLIT';
export type ResumeProposal = {
  /** Stable within one parse, for selection in the preview. */
  key: string; kind: ResumeProposalKind; locale: ResumeLocale;
  title: string; organization: string; startMonth: string; endMonth: string; current: boolean;
  /** The dates exactly as the resume wrote them, kept in plain text when they cannot be read safely. */
  dateText: string; description: string; tags: string[];
  /** The resume lines this proposal comes from, verbatim. Shown next to the proposal; never sent to the API. */
  excerpt: string; issues: ResumeIssue[];
};
export type ResumeParse = { locale: ResumeLocale; proposals: ResumeProposal[]; skipped: string[]; truncated: boolean; sectionsFound: number };
export type ResumeDateRange = { startMonth: string; endMonth: string; current: boolean; ambiguous: boolean; text: string; index: number };

const maxDescription = 3500;
const maxStatement = 4000;
const maxTitle = 200;
const maxHeadingLine = 60;
const maxTag = 80;
const maxTags = 40;

/**
 * Same-length fold: lower case without accents, keeping every UTF-16 unit in place so indexes into the folded text are
 * valid in the original. A character whose fold has another length (an emoji, a ligature) becomes the same number of "?".
 */
const foldChar = (char: string) => {
  const folded = char.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase();
  if (folded.length === char.length) return folded;
  const lower = char.toLocaleLowerCase();
  return lower.length === char.length ? lower : '?'.repeat(char.length);
};
export const foldResumeText = (value: string) => Array.from(value, foldChar).join('');

const headings: Record<ResumeLocale, Record<Exclude<ResumeSectionKind, 'other'> | 'other', string[]>> = {
  es: {
    summary: ['perfil', 'perfil profesional', 'resumen', 'resumen profesional', 'sobre mi', 'acerca de mi', 'extracto', 'objetivo', 'objetivo profesional'],
    experience: ['experiencia', 'experiencia laboral', 'experiencia profesional', 'historial laboral', 'trayectoria', 'trayectoria profesional', 'empleo', 'empleos'],
    education: ['formacion', 'formacion academica', 'educacion', 'estudios', 'titulacion', 'titulaciones', 'formacion complementaria'],
    skills: ['habilidades', 'competencias', 'aptitudes', 'conocimientos', 'habilidades tecnicas', 'competencias tecnicas', 'conocimientos tecnicos', 'herramientas', 'tecnologias'],
    languages: ['idiomas', 'lenguas'],
    certifications: ['certificaciones', 'certificados', 'cursos y certificaciones', 'licencias y certificaciones'],
    projects: ['proyectos', 'proyectos destacados', 'proyectos personales'],
    achievements: ['logros', 'premios', 'premios y reconocimientos', 'reconocimientos'],
    other: ['referencias', 'referencias laborales', 'referencias profesionales', 'intereses', 'intereses personales', 'aficiones', 'aficiones e intereses', 'datos personales', 'informacion personal', 'contacto', 'datos de contacto', 'informacion de contacto', 'enlaces', 'voluntariado', 'publicaciones'],
  },
  en: {
    summary: ['profile', 'professional profile', 'summary', 'professional summary', 'about me', 'objective', 'career objective', 'personal statement'],
    experience: ['experience', 'work experience', 'professional experience', 'employment', 'employment history', 'work history', 'career history'],
    education: ['education', 'academic background', 'qualifications', 'training', 'education and training'],
    skills: ['skills', 'technical skills', 'core skills', 'key skills', 'competencies', 'core competencies', 'tools', 'technologies', 'expertise'],
    languages: ['languages'],
    certifications: ['certifications', 'certificates', 'licenses and certifications', 'licences and certifications', 'courses and certifications'],
    projects: ['projects', 'selected projects', 'personal projects', 'key projects'],
    achievements: ['achievements', 'awards', 'honors', 'honours', 'awards and honors', 'accomplishments'],
    other: ['references', 'professional references', 'interests', 'personal interests', 'hobbies', 'hobbies and interests', 'interests and hobbies', 'personal details', 'personal information', 'contact', 'contact details', 'contact information', 'links', 'volunteering', 'volunteer experience', 'publications'],
  },
};
const headingIndex = new Map<string, { kind: ResumeSectionKind; locale: ResumeLocale }>();
for (const locale of ['es', 'en'] as const) for (const [kind, names] of Object.entries(headings[locale])) for (const name of names) headingIndex.set(name, { kind: kind as ResumeSectionKind, locale });

const skippedLeads = new Set(['referencias', 'references', 'aficiones', 'hobbies', 'intereses', 'interests']);
/** A line's section, when the whole line is a known heading ("EXPERIENCIA LABORAL:", "Skills", "Idiomas / Languages"). */
export function resumeHeading(line: string): { kind: ResumeSectionKind; locale: ResumeLocale } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > maxHeadingLine) return null;
  const folded = foldResumeText(trimmed).replace(/^[#*•·\s]+/u, '').replace(/[:\s]+$/u, '').replace(/\s+/gu, ' ');
  for (const part of [folded, ...folded.split(/\s+[/|]\s+/u)]) {
    const found = headingIndex.get(part.trim());
    if (found) return found;
  }
  // "Referencias de antiguos empleos", "Hobbies & sport": a short line that starts with a word only used to head a skipped
  // section also starts one, so referees or contact lines are never merged into the entry above. Other kinds need an
  // exact heading, because words such as "contacto" or "experiencia" also start ordinary lines.
  const words = folded.split(' ');
  if (!bullet.test(trimmed) && words.length <= 4 && !/[\p{N}.,;]/u.test(folded) && skippedLeads.has(words[0]!)) return headingIndex.get(words[0]!) ?? null;
  return null;
}

const months: Record<string, number> = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6, julio: 7, jul: 7,
  agosto: 8, ago: 8, septiembre: 9, setiembre: 9, sept: 9, sep: 9, set: 9, octubre: 10, oct: 10, noviembre: 11, nov: 11, diciembre: 12, dic: 12,
  january: 1, jan: 1, february: 2, march: 3, april: 4, apr: 4, june: 6, july: 7, august: 8, aug: 8, september: 9,
  october: 10, november: 11, december: 12, dec: 12,
};
const monthNames = Object.keys(months).sort((a, b) => b.length - a.length).join('|');
/** One date: "ene. 2020", "enero de 2020", "January 2020", "03/2021", "3.2021", "2021-03" or a bare year. Linear patterns only. */
const datePattern = new RegExp(`\\b(?:(${monthNames})\\.?(?:\\s+de)?\\s+((?:19|20)\\d{2})|(0?[1-9]|1[0-2])\\s?[/.-]\\s?((?:19|20)\\d{2})|((?:19|20)\\d{2})[/.-](0[1-9]|1[0-2])(?!\\d)|((?:19|20)\\d{2}))\\b`, 'gu');
const presentPattern = /^(?:actualidad|actual|presente|hoy|la fecha|en curso|present|current|now|today|ongoing)\b/u;
const rangeSeparator = /^\s*(?:-|–|—|~|to|a|al|hasta|until)\s*/u;

type DatePoint = { month: string | null; year: string; index: number; end: number };
function datePoints(folded: string): DatePoint[] {
  const points: DatePoint[] = [];
  for (const match of folded.matchAll(datePattern)) {
    const [whole, name, nameYear, numMonth, numYear, isoYear, isoMonth, bareYear] = match;
    const index = match.index ?? 0;
    // "2010/11" or "2011-12" is usually an academic year, not a month: it is left without a month.
    const academic = Boolean(isoMonth) && Number(isoMonth) === (Number(isoYear) + 1) % 100;
    const month = name ? months[name]! : numMonth ? Number(numMonth) : isoMonth && !academic ? Number(isoMonth) : null;
    const year = nameYear ?? numYear ?? isoYear ?? bareYear!;
    points.push({ month: month === null ? null : `${year}-${String(month).padStart(2, '0')}`, year, index, end: index + whole.length });
  }
  return points;
}

/**
 * The first date range in a line: a start date followed by a separator and an end date or a word for "present", or a
 * single date. A year without a month, an end before the start, or a single date without an end is ambiguous: no month
 * is filled in, the original text is kept and the person completes it.
 */
export function parseResumeDateRange(line: string): ResumeDateRange | null {
  const folded = foldResumeText(line);
  const points = datePoints(folded);
  const first = points[0];
  if (!first) return null;
  const after = folded.slice(first.end);
  const separator = rangeSeparator.exec(after);
  let endMonth = ''; let current = false; let ambiguous = first.month === null; let end = first.end;
  if (separator) {
    const rest = after.slice(separator[0].length);
    const present = presentPattern.exec(rest);
    const second = points[1];
    if (present) { current = true; end = first.end + separator[0].length + present[0].length; }
    else if (second && second.index === first.end + separator[0].length) {
      end = second.end;
      if (second.month === null) ambiguous = true; else endMonth = second.month;
    } else ambiguous = true;
  } else ambiguous = true;
  const startMonth = first.month ?? '';
  if (startMonth && endMonth && endMonth < startMonth) ambiguous = true;
  return ambiguous
    ? { startMonth: '', endMonth: '', current: false, ambiguous: true, text: line.slice(first.index, end).trim(), index: first.index }
    : { startMonth, endMonth: current ? '' : endMonth, current, ambiguous: false, text: line.slice(first.index, end).trim(), index: first.index };
}

const bullet = /^\s*(?:[-*•·▪●◦‣–—]|\d{1,2}[.)])\s+/u;
const isBullet = (line: string) => bullet.test(line);
const withoutBullet = (line: string) => line.replace(bullet, '').trim();
const separators = [' — ', ' – ', ' | ', ' · ', ' @ ', ' at ', ' en ', ', ', ' - '];
const edgeCharacters = new Set([' ', '\t', '|', '·', ',', ';', ':', '(', ')', '[', ']', '–', '—', '-']);
/** Trims separators at both ends with a loop rather than a pattern, which would backtrack on long runs of them. */
function trimEdges(value: string): string {
  let from = 0; let to = value.length;
  while (from < to && edgeCharacters.has(value[from]!)) from++;
  while (to > from && edgeCharacters.has(value[to - 1]!)) to--;
  return value.slice(from, to);
}
/** A long line ending in a full stop reads as a sentence; a short one can be an employer such as "Ficticia S.L.". */
const sentence = (line: string) => /;$/u.test(line) || (/\.$/u.test(line) && line.split(/\s+/u).length > 8);
/** A short line that can name a role or an employer: not a bullet, not a sentence, no date. */
const headingLike = (line: string) => Boolean(line) && !isBullet(line) && line.length <= 120 && !sentence(line) && !parseResumeDateRange(line);

function splitTitle(text: string): { title: string; organization: string } {
  for (const separator of separators) {
    const at = text.indexOf(separator);
    if (at > 0) return { title: text.slice(0, at).trim(), organization: text.slice(at + separator.length).trim() };
  }
  return { title: text.trim(), organization: '' };
}

/** Line chunks of at most `limit` characters; a single longer line is cut at the last space before the limit. */
function chunks(lines: string[], limit: number): string[] {
  const result: string[] = []; let current = '';
  for (const raw of lines) {
    let line = raw;
    while (line.length > limit) { const cut = line.lastIndexOf(' ', limit) > 0 ? line.lastIndexOf(' ', limit) : limit; if (current) { result.push(current); current = ''; } result.push(line.slice(0, cut).trim()); line = line.slice(cut).trim(); }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) { result.push(current); current = line; } else current = next;
  }
  if (current) result.push(current);
  return result.filter(Boolean);
}

type Section = { kind: ResumeSectionKind; heading: string; locale: ResumeLocale | null; lines: string[] };

/** Lines before the first heading are the header (identity, handled by detectIdentity) and never become entries. */
export function splitResumeSections(resume: string): { header: string[]; sections: Section[] } {
  const header: string[] = []; const sections: Section[] = [];
  for (const raw of resume.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = raw.replace(/[\t\u00a0 ]+/gu, ' ').trim();
    const heading = resumeHeading(line);
    if (heading) { sections.push({ ...heading, heading: line.replace(/[:\s]+$/u, ''), lines: [] }); continue; }
    if (sections.length) sections[sections.length - 1]!.lines.push(line); else if (line) header.push(line);
  }
  return { header, sections };
}

const spanishWords = new Set(['de', 'la', 'el', 'en', 'y', 'con', 'para', 'los', 'las', 'del', 'una', 'por']);
const englishWords = new Set(['the', 'and', 'of', 'with', 'for', 'to', 'in', 'a', 'an', 'on', 'by', 'at']);
/** The resume's main language: its headings first, then common words. Spanish wins a tie, as the app's default. */
export function detectResumeLocale(resume: string, sections = splitResumeSections(resume).sections): ResumeLocale {
  let es = 0; let en = 0;
  for (const section of sections) { if (section.locale === 'es') es += 3; if (section.locale === 'en') en += 3; }
  for (const word of foldResumeText(resume.slice(0, 20_000)).split(/[^\p{L}]+/u)) { if (spanishWords.has(word)) es++; if (englishWords.has(word)) en++; }
  return en > es ? 'en' : 'es';
}

const blank = (locale: ResumeLocale) => ({ title: '', organization: '', startMonth: '', endMonth: '', current: false, dateText: '', tags: [] as string[], locale, issues: [] as ResumeIssue[] });

/** Jobs or studies: an entry starts at each line with a date range, headed by the role/employer lines around it. */
function datedEntries(section: Section, kind: 'experience' | 'education', locale: ResumeLocale): Array<Omit<ResumeProposal, 'key'>> {
  const lines = section.lines;
  const dated = lines.map((line, index) => ({ index, range: parseResumeDateRange(line) })).filter((item) => item.range);
  const paragraphs = () => {
    const groups: string[][] = [[]];
    for (const line of lines) { if (!line) { if (groups[groups.length - 1]!.length) groups.push([]); } else groups[groups.length - 1]!.push(line); }
    return groups.filter((group) => group.length);
  };
  if (!dated.length) {
    return paragraphs().flatMap((group) => chunks(group.map(withoutBullet), maxStatement).map((description, _part, all) => ({
      ...blank(locale), kind, description, excerpt: group.join('\n'), issues: ['MISSING_DATES', ...(all.length > 1 ? ['SPLIT' as const] : [])],
    })));
  }
  const entries: Array<Omit<ResumeProposal, 'key'>> = [];
  const starts = dated.map(({ index, range }, position) => {
    const floor = position ? dated[position - 1]!.index + 1 : 0;
    const around = lines[index]!.slice(0, range!.index) + ' ' + lines[index]!.slice(range!.index + range!.text.length);
    const rest = trimEdges(around).replace(/\s+/gu, ' ').trim();
    const headingLines: number[] = [];
    for (let at = index - 1; at >= floor && headingLines.length < (rest ? 1 : 2) && headingLike(lines[at]!); at--) headingLines.unshift(at);
    if (rest && headingLines.length && splitTitle(rest).organization) headingLines.length = 0;
    return { index, range: range!, rest, headingLines, start: headingLines[0] ?? index };
  });
  const preamble = lines.slice(0, starts[0]!.start).filter(Boolean);
  if (preamble.length) entries.push({ ...blank(locale), kind, description: chunks(preamble.map(withoutBullet), maxStatement)[0]!, excerpt: preamble.join('\n'), issues: ['MISSING_DATES'] });
  starts.forEach((entry, position) => {
    const until = position + 1 < starts.length ? starts[position + 1]!.start : lines.length;
    const parts = [...entry.headingLines.map((at) => lines[at]!), ...(entry.rest ? [entry.rest] : [])];
    let { title, organization } = parts.length >= 2 ? { title: parts[0]!, organization: parts.slice(1).join(' ') } : splitTitle(parts[0] ?? '');
    let body = lines.slice(entry.index + 1, until);
    const next = body.findIndex(Boolean);
    if (!organization && next !== -1 && headingLike(body[next]!) && body.slice(next + 1).some(Boolean)) { organization = body[next]!; body = body.slice(next + 1); }
    title = trimEdges(title); organization = trimEdges(organization);
    const descriptionLines = body.filter(Boolean).map(withoutBullet);
    if (title.length > maxTitle) { descriptionLines.unshift(title); title = ''; }
    if (organization.length > maxTitle) { descriptionLines.unshift(organization); organization = ''; }
    const pieces = chunks(descriptionLines, maxDescription);
    const excerpt = lines.slice(entry.start, until).filter(Boolean).join('\n');
    const issues: ResumeIssue[] = [];
    if (entry.range.ambiguous) issues.push('AMBIGUOUS_DATES');
    if (!title || !organization) issues.push('MISSING_ORGANIZATION');
    (pieces.length ? pieces : ['']).forEach((description, _part, all) => entries.push({
      ...blank(locale), kind, title, organization, startMonth: entry.range.startMonth, endMonth: entry.range.endMonth, current: entry.range.current,
      dateText: entry.range.text, description, excerpt, issues: all.length > 1 ? [...issues, 'SPLIT'] : issues,
    }));
  });
  return entries;
}

/** Top-level items of a list line, keeping commas inside parentheses: "Spanish (native, C2), English (C1)". */
function listItems(line: string): string[] {
  const items: string[] = []; let depth = 0; let current = '';
  for (const char of line) {
    if (char === '(' || char === '[') depth++;
    if ((char === ')' || char === ']') && depth > 0) depth--;
    if (depth === 0 && [',', ';', '·', '|', '•'].includes(char)) { items.push(current); current = ''; } else current += char;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

function listEntries(section: Section, kind: ResumeProposalKind, locale: ResumeLocale, byItem: boolean): Array<Omit<ResumeProposal, 'key'>> {
  const entries: Array<Omit<ResumeProposal, 'key'>> = [];
  for (const line of section.lines.filter(Boolean)) {
    const text = withoutBullet(line);
    const items = byItem ? listItems(text) : [text];
    for (const item of items) for (const description of chunks([item], maxStatement)) entries.push({ ...blank(locale), kind, description, excerpt: line });
  }
  return entries;
}

/** Skills: one entry per list line, with its items as keywords; runs of one-word lines are merged into one entry. */
function skillEntries(section: Section, locale: ResumeLocale): Array<Omit<ResumeProposal, 'key'>> {
  const entries: Array<Omit<ResumeProposal, 'key'>> = [];
  let run: string[] = [];
  const tagsOf = (items: string[]) => [...new Set(items.map((item) => item.replace(/^[^:]{1,40}:\s*/u, '').trim()).filter((item) => item && item.length <= maxTag))].slice(0, maxTags);
  const flush = () => { if (run.length) { const description = run.map(withoutBullet).join(', '); if (description.length <= maxStatement) entries.push({ ...blank(locale), kind: 'skill_evidence', description, tags: tagsOf(run.map(withoutBullet)), excerpt: run.join('\n') }); run = []; } };
  for (const line of section.lines.filter(Boolean)) {
    const text = withoutBullet(line); const items = listItems(text);
    if (items.length <= 1 && text.length <= 40) { run.push(line); continue; }
    flush();
    for (const description of chunks([text], maxStatement)) entries.push({ ...blank(locale), kind: 'skill_evidence', description, tags: tagsOf(items), excerpt: line });
  }
  flush();
  return entries;
}

/** Projects: a project starts at a line that is not a bullet; the bullets below it belong to it. */
function projectEntries(section: Section, locale: ResumeLocale): Array<Omit<ResumeProposal, 'key'>> {
  const groups: string[][] = [];
  for (const line of section.lines) {
    if (!line) { if (groups.length && groups[groups.length - 1]!.length) groups.push([]); continue; }
    const last = groups[groups.length - 1];
    if (!last || (!isBullet(line) && last.length && last.some(isBullet))) groups.push([line]); else last.push(line);
  }
  return groups.filter((group) => group.length).flatMap((group) => chunks(group.map(withoutBullet), maxStatement).map((description, _part, all) => ({
    ...blank(locale), kind: 'project' as const, description, excerpt: group.join('\n'), issues: all.length > 1 ? ['SPLIT' as const] : [],
  })));
}

/**
 * Editable proposals from a resume's text. Each proposal keeps the exact lines it came from. At most 100 are returned
 * (the import limit); `truncated` says that more were found. `skipped` names sections that are not imported.
 */
export function parseResume(resume: string): ResumeParse {
  const { sections } = splitResumeSections(resume);
  const locale = detectResumeLocale(resume, sections);
  const proposals: Array<Omit<ResumeProposal, 'key'> & { section: number }> = [];
  const skipped: string[] = [];
  sections.forEach((section, index) => {
    const sectionLocale = section.locale ?? locale;
    const add = (entries: Array<Omit<ResumeProposal, 'key'>>) => entries.forEach((entry) => proposals.push({ ...entry, section: index }));
    switch (section.kind) {
      case 'experience': case 'education': add(datedEntries(section, section.kind, sectionLocale)); break;
      case 'skills': add(skillEntries(section, sectionLocale)); break;
      case 'languages': add(listEntries(section, 'language', sectionLocale, true)); break;
      case 'certifications': add(listEntries(section, 'certification', sectionLocale, false)); break;
      case 'achievements': add(listEntries(section, 'achievement', sectionLocale, false)); break;
      case 'projects': add(projectEntries(section, sectionLocale)); break;
      case 'summary': {
        const text = section.lines.filter(Boolean);
        add(chunks([text.join(' ')], maxStatement).map((description, _part, all) => ({ ...blank(sectionLocale), kind: 'summary', description, excerpt: text.join('\n'), issues: all.length > 1 ? ['SPLIT'] : [] })));
        break;
      }
      case 'other': skipped.push(section.heading); break;
    }
  });
  const kept = proposals.filter((proposal) => proposal.description || proposal.title || proposal.organization);
  const counters = new Map<number, number>();
  return {
    locale, skipped, sectionsFound: sections.length, truncated: kept.length > maxImportedFacts,
    proposals: kept.slice(0, maxImportedFacts).map(({ section, ...proposal }) => {
      const n = counters.get(section) ?? 0; counters.set(section, n + 1);
      return { key: `${section}:${n}`, ...proposal };
    }),
  };
}

/** Whether a proposal has every structured field its kind needs; otherwise it is imported as plain text. */
export function hasResumeDates(proposal: Pick<ResumeProposal, 'kind' | 'title' | 'organization' | 'startMonth' | 'endMonth' | 'current'>): boolean {
  return (proposal.kind === 'experience' || proposal.kind === 'education') && Boolean(proposal.title && proposal.organization && proposal.startMonth && (proposal.current || proposal.endMonth))
    && (proposal.current || proposal.endMonth >= proposal.startMonth);
}

export type ResumeFactInput = { kind: string; statement: string; tags: string[]; employment?: { role: string; company: string; startMonth: string; endMonth?: string; current: boolean; locale: ResumeLocale }; education?: { qualification: string; institution: string; startMonth: string; endMonth?: string; current: boolean; locale: ResumeLocale } };

/**
 * The fact the import API receives for a proposal. Jobs and studies with complete fields become structured entries;
 * otherwise the role, employer and the dates as written are kept in plain text so nothing is lost or invented, and the
 * profile offers to complete the fields later. The excerpt itself is never part of the fact.
 */
export function resumeProposalFact(proposal: ResumeProposal): ResumeFactInput {
  const tags = proposal.tags.slice(0, maxTags);
  if (hasResumeDates(proposal)) {
    const dates = { startMonth: proposal.startMonth, ...(proposal.current ? {} : { endMonth: proposal.endMonth }), current: proposal.current, locale: proposal.locale };
    return proposal.kind === 'experience'
      ? { kind: 'experience', statement: proposal.description, tags, employment: { role: proposal.title, company: proposal.organization, ...dates } }
      : { kind: 'education', statement: proposal.description, tags, education: { qualification: proposal.title, institution: proposal.organization, ...dates } };
  }
  const heading = [proposal.title, proposal.organization].filter(Boolean).join(' · ');
  return { kind: proposal.kind, statement: [heading, proposal.dateText, proposal.description].filter(Boolean).join('\n').slice(0, maxStatement), tags };
}

/** The statement the profile will store for a proposal (structured entries are formatted), for duplicate checks. */
export function resumeProposalStatement(proposal: ResumeProposal): string | null {
  const parsed = factSchema.safeParse(resumeProposalFact(proposal));
  return parsed.success ? parsed.data.statement : null;
}
