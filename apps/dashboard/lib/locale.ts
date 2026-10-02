export type Locale = 'es' | 'en';

export function initialLocale(acceptLanguage: string | null, cookieLocale?: string): Locale {
  if (cookieLocale === 'en' || cookieLocale === 'es') return cookieLocale;
  return acceptLanguage?.toLowerCase().split(',')[0]?.split(';')[0].trim().startsWith('es') ? 'es' : 'en';
}
