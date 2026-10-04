/** Versioned, profile-independent matching for saved job searches. */
export type SearchWorkMode = 'any' | 'remote' | 'hybrid' | 'onsite' | 'unknown' | string;
export type SearchLocationStatus = 'not_requested' | 'compatible' | 'incompatible' | 'unknown';
export type SearchRoleMatch = 'exact' | 'equivalent' | 'related' | 'none';

export type SearchJob = {
  title: string;
  company: string;
  location: string | null;
  workMode: SearchWorkMode;
  countries?: string[];
  worldwide?: boolean;
};

export type SearchCriteria = {
  role: string | null;
  company: string | null;
  location: string | null;
  workMode: SearchWorkMode;
  includeRelated?: boolean;
  matcherVersion?: number;
};

export type SearchMatch = {
  matched: boolean;
  unknownLocation: boolean;
  score: number;
  reasons: string[];
  locationStatus: SearchLocationStatus;
  roleMatch: SearchRoleMatch;
};

/** Normalizes accents and case while retaining punctuation that distinguishes technical terms. */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase('en').replace(/\s+/gu, ' ').trim();
}

const tokens = (value: string): string[] => {
  const text = normalizeSearchText(value);
  return text.match(/\.net|c\+\+|c#|[\p{L}\p{N}]+(?:[._][\p{L}\p{N}]+)*/gu) ?? [];
};
const hasPhrase = (text: string, wanted: string) => {
  const source = tokens(text); const target = tokens(wanted);
  if (!target.length || target.length > source.length) return false;
  return source.some((_, start) => target.every((token, offset) => source[start + offset] === token));
};

type RoleFamily = { equivalent: string[][]; related: string[] };
// Deliberately compact. Entries are reviewable product vocabulary, not inferred from a profile.
const roleFamilies: RoleFamily[] = [
  { equivalent: [['QA', 'quality assurance', 'software quality assurance', 'QA engineer', 'quality assurance engineer', 'software test engineer', 'ingeniero de pruebas', 'ingeniera de pruebas', 'ingeniero QA', 'ingeniera QA', 'tester de software'], ['SDET', 'software development engineer in test']], related: ['test automation engineer', 'automation QA engineer', 'quality analyst', 'analista de calidad', 'test analyst'] },
  { equivalent: [['software engineer', 'software developer', 'ingeniero de software', 'ingeniera de software', 'desarrollador de software', 'desarrolladora de software']], related: ['backend developer', 'frontend developer', 'full stack developer', 'programador', 'programadora', 'web developer', 'desarrollador web', 'desarrolladora web'] },
  { equivalent: [['product designer', 'diseñador de producto', 'diseñadora de producto'], ['UX designer', 'diseñador UX', 'diseñadora UX']], related: ['UI designer', 'diseñador UI', 'diseñadora UI', 'interaction designer', 'service designer', 'diseñador de servicios', 'diseñadora de servicios'] },
  { equivalent: [['customer support', 'customer support specialist', 'customer service representative', 'customer service agent', 'soporte al cliente', 'especialista de soporte al cliente', 'agente de atención al cliente', 'agente de atencion al cliente']], related: ['technical support', 'technical support specialist', 'soporte técnico', 'soporte tecnico', 'help desk analyst', 'service desk analyst'] },
  { equivalent: [['digital marketing specialist', 'especialista en marketing digital'], ['marketing specialist', 'especialista de marketing', 'especialista en marketing']], related: ['growth marketer', 'content marketer', 'SEO specialist', 'paid media specialist', 'especialista SEO', 'especialista de contenidos'] },
  { equivalent: [['administrative assistant', 'asistente administrativo', 'asistente administrativa', 'auxiliar administrativo', 'auxiliar administrativa'], ['office administrator'], ['administrative coordinator', 'coordinador administrativo', 'coordinadora administrativa']], related: ['office manager', 'executive assistant', 'asistente ejecutivo', 'asistente ejecutiva', 'receptionist', 'recepcionista'] },
];
const familyFor = (value: string) => {
  return roleFamilies.find((family) => family.equivalent.some((group) => group.some((entry) => hasPhrase(value, entry))));
};
const equivalentGroupFor = (value: string) => {
  const family = familyFor(value);
  return family?.equivalent.find((group) => group.some((entry) => hasPhrase(value, entry)));
};
const relatedFor = (value: string) => {
  return roleFamilies.find((family) => family.related.some((entry) => hasPhrase(value, entry)));
};
const modifiersMatch = (left: string, right: string, aliases: string[]) => {
  const query = tokens(left);
  const core = aliases.filter((entry) => hasPhrase(left,entry)).sort((x,y) => tokens(y).length-tokens(x).length)[0];
  if (!core) return false;
  const coreTokens=tokens(core);
  const start=query.findIndex((_,index)=>coreTokens.every((token,offset)=>query[index+offset]===token));
  const modifiers=[...query.slice(0,start),...query.slice(start+coreTokens.length)];
  return modifiers.every((token)=>tokens(right).includes(token));
};
const equivalentRole = (left: string, right: string) => {
  const a = equivalentGroupFor(left); const b = equivalentGroupFor(right);
  return Boolean(a && b && a === b && modifiersMatch(left, right, a));
};
const seniority = (value: string) => {
  const words = tokens(value);
  return ['intern', 'internship', 'junior', 'mid', 'middle', 'senior', 'staff', 'principal', 'lead', 'director'].find((level) => words.includes(level)) ?? null;
};

function classifyRole(query: string | null, title: string): SearchRoleMatch {
  if (!query?.trim()) return 'exact';
  const queryLevel = seniority(query); const titleLevel = seniority(title);
  if (queryLevel && queryLevel !== titleLevel) return 'none';
  const queryFamily = familyFor(query);
  const titleFamily = familyFor(title);
  const titleRelated = relatedFor(title);
  const queryRelated = relatedFor(query);
  const queryGroup = equivalentGroupFor(query);
  const titleGroup = equivalentGroupFor(title);
  const distinctRolesInFamily = Boolean(queryFamily && titleFamily && queryFamily === titleFamily && queryGroup && titleGroup && queryGroup !== titleGroup);
  if (distinctRolesInFamily || (queryFamily && titleRelated && queryFamily === titleRelated) || (titleFamily && queryRelated && titleFamily === queryRelated)) {
    return modifiersMatch(query, title, queryGroup ?? queryRelated?.related ?? []) ? 'related' : 'none';
  }
  if (hasPhrase(title, query)) return 'exact';
  if (equivalentRole(query, title)) return 'equivalent';

  // Unlisted professions still match when their full token phrase appears in the title.
  return 'none';
}

const countryAliases: Record<string, string[]> = {
  es: ['spain', 'españa', 'espana'], gb: ['united kingdom', 'uk', 'great britain', 'britain', 'england', 'scotland', 'wales'],
  us: ['united states', 'usa', 'us', 'u.s.', 'u.s.a.'], de: ['germany', 'deutschland', 'alemania'], fr: ['france', 'francia'],
  pt: ['portugal'], it: ['italy', 'italia'], nl: ['netherlands', 'the netherlands', 'paises bajos', 'países bajos'],
  ie: ['ireland', 'irlanda'], mx: ['mexico', 'méxico'], ar: ['argentina'], ca: ['canada', 'canadá'], br: ['brazil', 'brasil'],
  in: ['india'], pl: ['poland', 'polonia'], au: ['australia'], sg: ['singapore'],
};
const countryKey = (value: string) => {
  const key = normalizeSearchText(value).replace(/\./g, '').trim();
  if (countryAliases[key]) return key;
  if (/^[a-z]{2}$/.test(key)) {
    const name = new Intl.DisplayNames(['en'],{type:'region'}).of(key.toUpperCase());
    if (name && name !== key.toUpperCase() && key !== 'zz') return key;
  }
  return Object.entries(countryAliases).find(([, names]) => names.some((name) => normalizeSearchText(name).replace(/\./g, '') === key))?.[0] ?? null;
};
const explicitCountriesIn = (text: string) => Object.entries(countryAliases).filter(([, names]) => names.some((name) => hasPhrase(text, name))).map(([code]) => code);
const explicitlyRestricted = (text: string) => /\b(only|based in|located in|must be located|residents? of|restricted to|limited to|solo|únicamente|unicamente|residentes de)\b/u.test(normalizeSearchText(text));
const incidentalCountryContext = (text: string) => /\b(clients?|customers?|product|team|office|market|sales|timezone|time zone|hours|operations)\b/u.test(normalizeSearchText(text));
const explicitlyWorldwide = (text: string) => /\b(worldwide|anywhere|global(?:ly)?|any country|todo el mundo|cualquier pais)\b/u.test(normalizeSearchText(text));

function locationStatus(job: SearchJob, criteria: SearchCriteria): SearchLocationStatus {
  const requestedCountry = criteria.location?.trim() ? countryKey(criteria.location) : null;
  if (!criteria.location?.trim()) return 'not_requested';
  const structured = (job.countries ?? []).map(countryKey).filter((country): country is string => country !== null);
  if (structured.length) return requestedCountry ? (structured.includes(requestedCountry) ? 'compatible' : 'incompatible') : 'unknown';
  const location = job.location ?? '';
  if (!location.trim()) return job.worldwide === true ? 'compatible' : 'unknown';
  const named = explicitCountriesIn(location);
  if (requestedCountry && named.includes(requestedCountry)) return 'compatible';
  if (requestedCountry && job.worldwide === true && named.length) return 'unknown';
  if (requestedCountry && named.length && explicitlyRestricted(location)) return 'incompatible';
  if (requestedCountry && named.length === 1 && !incidentalCountryContext(location)) return 'incompatible';
  if (job.worldwide === true || explicitlyWorldwide(location)) return named.length && explicitlyRestricted(location) ? 'unknown' : 'compatible';
  if (!requestedCountry && hasPhrase(location, criteria.location)) return 'compatible';
  // City, region, timezone, and vague remote claims are insufficient country evidence.
  return 'unknown';
}

function v1(job: SearchJob, criteria: SearchCriteria): SearchMatch {
  const clean = (s: string | null) => normalizeSearchText(s ?? '').replace(/\p{M}+/gu, '');
  const role = clean(criteria.role); const company = clean(criteria.company); const wantedLocation = clean(criteria.location);
  const title = clean(job.title); const employer = clean(job.company); const loc = clean(job.location);
  const aliases: Record<string, string[]> = { spain: ['espana', 'españa', 'spanish'], espana: ['spain', 'spanish'], germany: ['alemania', 'deutschland', 'german'], alemania: ['germany', 'deutschland'], 'united kingdom': ['uk', 'britain', 'england'], uk: ['united kingdom', 'britain', 'england'], 'united states': ['usa', 'us'], usa: ['united states', 'us'] };
  const broad = /\b(worldwide|anywhere|global|europe|european union|emea|multiple locations|various locations)\b/.test(loc) || /^remote(?:\s+only)?$/.test(loc);
  const roleOk = !role || role.split(/\s+/).filter(Boolean).every((word) => title.includes(word));
  const companyOk = !company || company.split(/\s+/).filter(Boolean).every((word) => employer.includes(word));
  const modeStatus = criteria.workMode === 'any' ? 'not_requested' : job.workMode === 'unknown' ? 'unknown' : criteria.workMode === job.workMode ? 'compatible' : 'incompatible';
  const modeOk = modeStatus !== 'incompatible';
  const locationOk = !wantedLocation || !loc || broad || loc.includes(wantedLocation) || wantedLocation.split(/\s+/).some((word) => loc.includes(word)) || (aliases[wantedLocation] ?? []).some((alias) => loc.includes(alias));
  const matched = roleOk && companyOk && modeOk && locationOk;
  const unknown = matched && Boolean(wantedLocation && (!loc || broad));
  const roleMatch = !role ? 'exact' : !roleOk ? 'none' : hasPhrase(job.title, criteria.role ?? '') ? 'exact' : 'related';
  return { matched, unknownLocation: unknown, score: matched ? 100 : 0, reasons: matched ? ['MATCH_V1_LEGACY'] : ['NO_MATCH_V1_LEGACY'], locationStatus: !wantedLocation ? 'not_requested' : unknown ? 'unknown' : matched ? 'compatible' : 'incompatible', roleMatch };
}

/** Deterministic search relevance; never reads or infers candidate profile or legal authorization. */
export function evaluateSearchMatch(job: SearchJob, criteria: SearchCriteria): SearchMatch {
  if ((criteria.matcherVersion ?? 2) === 1) return v1(job, criteria);
  if (criteria.matcherVersion !== undefined && criteria.matcherVersion !== 2) throw new RangeError(`Unsupported matcherVersion: ${criteria.matcherVersion}`);

  const roleMatch = classifyRole(criteria.role, job.title);
  const companyOk = !criteria.company?.trim() || tokens(criteria.company).every((word) => tokens(job.company).includes(word));
  const modeStatus = criteria.workMode === 'any' ? 'not_requested' : job.workMode === 'unknown' ? 'unknown' : criteria.workMode === job.workMode ? 'compatible' : 'incompatible';
  const modeOk = modeStatus !== 'incompatible';
  const place = locationStatus(job, criteria);
  const reasons: string[] = [];
  if (criteria.role?.trim()) reasons.push(`ROLE_${roleMatch.toLocaleUpperCase('en')}`);
  if (criteria.company?.trim()) reasons.push(companyOk ? 'COMPANY_MATCH' : 'COMPANY_MISMATCH');
  if (criteria.workMode !== 'any') reasons.push(modeStatus === 'compatible' ? 'WORK_MODE_MATCH' : modeStatus === 'unknown' ? 'WORK_MODE_UNKNOWN' : 'WORK_MODE_MISMATCH');
  if (criteria.location?.trim()) reasons.push(`LOCATION_${place.toLocaleUpperCase('en')}`);
  const roleOk = roleMatch === 'exact' || roleMatch === 'equivalent' || (roleMatch === 'related' && criteria.includeRelated === true);
  const matched = roleOk && companyOk && modeOk && place !== 'incompatible';
  const roleScore = roleMatch === 'exact' ? 100 : roleMatch === 'equivalent' ? 90 : roleMatch === 'related' ? 60 : 0;
  const score = matched ? Math.round((roleScore * 0.7) + (companyOk ? 10 : 0) + (modeStatus === 'compatible' || modeStatus === 'not_requested' ? 10 : 5) + (place === 'compatible' || place === 'not_requested' ? 10 : 5)) : 0;
  if (!reasons.length) reasons.push('NO_FILTERS');
  return { matched, unknownLocation: matched && place === 'unknown', score, reasons, locationStatus: place, roleMatch };
}

/** One conservative source query; local matching still enforces the complete original criteria. */
export function providerSearchRole(value: string | null): string | null {
  if (!value?.trim()) return null;
  const group=equivalentGroupFor(value);
  if (!group) return value.trim();
  const alias=group.filter((entry)=>hasPhrase(value,entry)).sort((a,b)=>tokens(b).length-tokens(a).length)[0];
  if (!alias) return value.trim();
  const words=tokens(value), core=tokens(alias);
  const start=words.findIndex((_,index)=>core.every((token,offset)=>words[index+offset]===token));
  return [...words.slice(0,start),...tokens(group[0]!),...words.slice(start+core.length)].join(' ');
}
