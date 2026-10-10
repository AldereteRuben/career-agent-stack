/**
 * Identity and target-title proposals from an imported resume (ADR 018, task T7). Everything here is pure and runs in
 * the browser, where the resume text lives: the text is never sent to the API. Proposals are shown apart from the
 * facts and applied only when the person picks them; applying never removes anything the profile already has.
 */
import type { StructuredEntry } from './entries.js';

export type DetectedIdentity = { fullName?: string; email?: string; country?: string };
type IdentityField = keyof DetectedIdentity;
export type IdentityProposal = { field: IdentityField; current: string; proposed: string };
export type ProfileProposals = { identity: IdentityProposal[]; targetTitles: string[] };
export type ProfileProposalChoice = { identity?: DetectedIdentity; targetTitles?: string[] };

const maxTargetTitles = 30;
const suggestedTitles = 3;
const headerLines = 12;
const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/** Section headings that end the resume header (Spanish and English). */
const sectionHeading = /^(experiencia|experiencia laboral|experiencia profesional|formacion|formacion academica|educacion|estudios|habilidades|competencias|aptitudes|idiomas|certificaciones|proyectos|perfil|perfil profesional|resumen|sobre mi|experience|work experience|professional experience|employment|education|skills|languages|certifications|projects|profile|summary|about me|objective)\b/;
const documentTitle = /^(curriculum|curriculum vitae|cv|resume|hoja de vida)$/;
const maxEmailLength = 254;
const opening = new Set(['<', '(', '[', '{', '"', "'", '«']);
const closing = new Set(['>', ')', ']', '}', '"', "'", '»', '.', ',', ';', ':']);
const localPart = /^[A-Za-z0-9._%+-]+$/;
const domainLabel = /^[A-Za-z0-9-]+$/;
const topLevel = /^[A-Za-z]{2,}$/;
/** Whether a single word is an email address. Simple character checks on split parts: no backtracking patterns. */
function isEmail(word: string): boolean {
  const parts = word.split('@');
  if (parts.length !== 2 || !localPart.test(parts[0]!)) return false;
  const labels = parts[1]!.split('.');
  return labels.length >= 2 && labels.every((label) => domainLabel.test(label)) && topLevel.test(labels[labels.length - 1]!);
}
/** The first email address in the text, checking one whitespace-separated word at a time without its punctuation. */
function firstEmail(resume: string): string | undefined {
  for (const word of resume.split(/\s+/)) {
    if (!word.includes('@') || word.length > maxEmailLength + 4) continue;
    let from = 0; let to = word.length;
    while (from < to && opening.has(word[from]!)) from++;
    while (to > from && closing.has(word[to - 1]!)) to--;
    const candidate = word.slice(from, to);
    if (candidate.length <= maxEmailLength && isEmail(candidate)) return candidate;
  }
  return undefined;
}
const namePattern = /^[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){1,4}$/u;
/** Pseudo-regions and deprecated codes that are not useful as a work country (same as the dashboard picker). */
const excludedRegions = new Set(['AC', 'AN', 'BU', 'CP', 'CQ', 'CS', 'DD', 'DG', 'DY', 'EA', 'EU', 'EZ', 'FX', 'HV', 'IC', 'NH', 'NT', 'QO', 'RH', 'SU', 'TA', 'TP', 'UK', 'UN', 'VD', 'XA', 'XB', 'YD', 'YU', 'ZR', 'ZZ']);

let countryNames: Array<[string, string]> | null = null;
/** Folded Spanish and English country names to ISO codes, longest first so "Guinea-Bissau" wins over "Guinea". */
function countryNameIndex(): Array<[string, string]> {
  if (countryNames) return countryNames;
  const entries = new Map<string, string>();
  try {
    const displays = ['es', 'en'].map((locale) => new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' }));
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (excludedRegions.has(code)) continue;
      for (const display of displays) { const name = display.of(code); if (name && name !== code) entries.set(fold(name), code); }
    }
  } catch { /* Without Intl region names, no country is proposed. */ }
  countryNames = [...entries].sort((x, y) => y[0].length - x[0].length);
  return countryNames;
}

const maxHeaderLine = 200;
/** A line without trailing colons and spaces, trimmed with a loop rather than a backtracking pattern. */
function withoutTrailingColons(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ':' || line[end - 1] === ' ')) end--;
  return line.slice(0, end);
}
/**
 * The lines before the first section heading, at most the first twelve non-empty lines. Lines longer than a header
 * line could be (200 characters) are left out, which also keeps every later check on short text.
 */
function headerOf(resume: string): string[] {
  const lines = resume.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line.length <= maxHeaderLine).slice(0, headerLines);
  const end = lines.findIndex((line) => sectionHeading.test(withoutTrailingColons(fold(line))));
  return end === -1 ? lines : lines.slice(0, end);
}

/**
 * Name, email and country from a resume's text. The email is the first address in the text; the name is the first
 * header line that reads like a person's name; the country is proposed only when exactly one country is named in
 * the header. Anything uncertain is left out rather than guessed.
 */
export function detectIdentity(resume: string): DetectedIdentity {
  const detected: DetectedIdentity = {};
  const email = firstEmail(resume);
  if (email) detected.email = email;
  const header = headerOf(resume);
  for (const line of header) {
    const candidate = line.replace(/\s+/g, ' ');
    if (candidate.length > 80 || !namePattern.test(candidate) || documentTitle.test(fold(candidate))) continue;
    detected.fullName = candidate === candidate.toLocaleUpperCase() ? candidate.toLocaleLowerCase().replace(/(^|[\s'’-])\p{L}/gu, (letter) => letter.toLocaleUpperCase()) : candidate;
    break;
  }
  const headerText = ` ${fold(header.join(' ')).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const found = new Set<string>();
  let remaining = headerText;
  for (const [name, code] of countryNameIndex()) {
    const needle = ` ${name.replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    if (needle.trim().length < 4 || !remaining.includes(needle)) continue;
    found.add(code);
    remaining = remaining.replaceAll(needle, ' ');
  }
  const [country] = found;
  if (found.size === 1 && country) detected.country = country;
  return detected;
}

/**
 * Up to three recent job titles to offer as target titles: current jobs first, then by most recent end or start
 * month. Titles the person already has (ignoring case and accents) and repeats are left out.
 */
export function suggestTargetTitles(entries: readonly StructuredEntry[], current: readonly string[]): string[] {
  const have = new Set(current.map(fold));
  const recency = (entry: StructuredEntry) => entry.current ? '9999-99' : (entry.endMonth ?? entry.startMonth);
  const jobs = entries.filter((entry) => entry.type === 'employment' && entry.title.trim()).sort((a, b) => recency(b).localeCompare(recency(a)));
  const titles: string[] = [];
  for (const job of jobs) {
    const title = job.title.trim(); const key = fold(title);
    if (have.has(key)) continue;
    have.add(key); titles.push(title);
    if (titles.length === suggestedTitles) break;
  }
  return titles;
}

/** What the resume would add or change. Values equal to the profile's (ignoring case and accents) are not proposed. */
export function profileProposals(profile: Record<string, unknown>, detected: DetectedIdentity, titles: readonly string[] = []): ProfileProposals {
  const identity = record(profile.identity);
  const proposals: IdentityProposal[] = [];
  for (const field of ['fullName', 'email', 'country'] as const) {
    const proposed = text(detected[field]); const current = text(identity[field]);
    if (proposed && fold(proposed) !== fold(current)) proposals.push({ field, current, proposed });
  }
  const have = new Set((Array.isArray(record(profile.preferences).targetTitles) ? record(profile.preferences).targetTitles as unknown[] : []).filter((title): title is string => typeof title === 'string').map(fold));
  return { identity: proposals, targetTitles: titles.filter((title) => !have.has(fold(title))) };
}

/**
 * The profile with only the chosen proposals applied. Identity fields are set only when chosen; target titles are
 * appended after the existing ones, never replacing them. Every other key of the profile is kept as it was.
 */
export function applyProfileProposals(profile: Record<string, unknown>, choice: ProfileProposalChoice): Record<string, unknown> {
  const identity = { ...record(profile.identity) };
  let identityChanged = false;
  for (const field of ['fullName', 'email', 'country'] as const) {
    const value = text(choice.identity?.[field]);
    if (value) { identity[field] = field === 'country' ? value.toUpperCase() : value; identityChanged = true; }
  }
  const preferences = { ...record(profile.preferences) };
  const existing = Array.isArray(preferences.targetTitles) ? (preferences.targetTitles as unknown[]).filter((title): title is string => typeof title === 'string') : [];
  const have = new Set(existing.map(fold));
  const added = (choice.targetTitles ?? []).map((title) => title.trim()).filter((title) => title && !have.has(fold(title)) && have.add(fold(title)));
  const next: Record<string, unknown> = identityChanged ? { ...profile, identity } : { ...profile };
  if (added.length) next.preferences = { ...preferences, targetTitles: [...existing, ...added].slice(0, maxTargetTitles) };
  return next;
}
