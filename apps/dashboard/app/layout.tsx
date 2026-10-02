import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { LocaleProvider } from '@/lib/i18n';
import { initialLocale } from '@/lib/locale';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const locale = initialLocale((await headers()).get('accept-language'), (await cookies()).get('locale')?.value);
  return locale === 'en'
    ? { title: 'Career Stack · Your career space', description: 'A private workspace for your job search.' }
    : { title: 'Career Stack · Tu espacio de carrera', description: 'Un espacio privado para organizar tu búsqueda de empleo.' };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = initialLocale((await headers()).get('accept-language'), (await cookies()).get('locale')?.value);
  return <html lang={locale} data-scroll-behavior="smooth"><body><LocaleProvider locale={locale}>{children}</LocaleProvider></body></html>;
}
