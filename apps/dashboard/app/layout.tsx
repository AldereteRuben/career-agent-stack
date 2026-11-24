import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { LocaleProvider } from '@/lib/i18n';
import { initialLocale } from '@/lib/locale';
import { initialTheme, themeAttribute } from '@/lib/theme';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const locale = initialLocale((await headers()).get('accept-language'), (await cookies()).get('locale')?.value);
  return locale === 'en'
    ? { title: 'Career Stack · Your career space', description: 'A private workspace for your job search.' }
    : { title: 'Career Stack · Tu espacio de carrera', description: 'Un espacio privado para organizar tu búsqueda de empleo.' };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const locale = initialLocale((await headers()).get('accept-language'), cookieStore.get('locale')?.value);
  // Read on the server so the first paint already uses the theme chosen in Settings.
  const theme = themeAttribute(initialTheme(cookieStore.get('theme')?.value));
  return <html lang={locale} data-scroll-behavior="smooth" data-theme={theme}><body><LocaleProvider locale={locale}>{children}</LocaleProvider></body></html>;
}
