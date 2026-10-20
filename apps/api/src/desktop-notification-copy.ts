export function notificationText(language: 'en' | 'es', count: number): string {
  return language === 'es' ? `Nuevas ofertas encontradas: ${count}` : `New jobs found: ${count}`;
}
