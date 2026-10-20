export function followUpEmailText(language: 'es' | 'en', subject: string, body: string): string {
  return `${language === 'es' ? 'Asunto' : 'Subject'}: ${subject}\n\n${body}`;
}
