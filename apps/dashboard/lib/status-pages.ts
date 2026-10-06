import type { Locale } from './locale';
import type { Bilingual } from './labels';

/** Texts of the not-found and error pages. Every entry has both languages; status-pages.test.ts checks it. */
export const statusPageText = {
  notFound: {
    eyebrow: { es: 'ERROR 404', en: 'ERROR 404' },
    title: { es: 'No encontramos esta página', en: 'We could not find this page' },
    detail: { es: 'La dirección no existe o cambió. Vuelve a tus búsquedas o a la página anterior.', en: 'The address does not exist or has changed. Go back to your searches or to the previous page.' },
    search: { es: 'Buscar empleo', en: 'Find jobs' },
    back: { es: 'Volver a la página anterior', en: 'Go back to the previous page' },
  },
  error: {
    eyebrow: { es: 'ALGO SALIÓ MAL', en: 'SOMETHING WENT WRONG' },
    title: { es: 'No pudimos mostrar esta página', en: 'We could not show this page' },
    detail: { es: 'Tus datos guardados siguen en tu equipo; lo que no hayas guardado en esta página puede perderse. Puedes reintentar o ir al inicio.', en: 'Your saved data is still on your computer; anything you have not saved on this page may be lost. You can try again or go to the start.' },
    retry: { es: 'Reintentar', en: 'Try again' },
    home: { es: 'Ir al inicio', en: 'Go to the start' },
  },
} satisfies Record<string, Record<string, Bilingual>>;

/**
 * Language when the app's language provider is not available (a failure of the layout itself): the `locale` cookie the
 * language switch writes, otherwise the browser language, the same rule the server uses.
 */
export function localeWithoutProvider(cookie: string, browserLanguage: string): Locale {
  const saved = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('locale='))?.slice('locale='.length);
  if (saved === 'es' || saved === 'en') return saved;
  return browserLanguage.toLowerCase().startsWith('es') ? 'es' : 'en';
}
