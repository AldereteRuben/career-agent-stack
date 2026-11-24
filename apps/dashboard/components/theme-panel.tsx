'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui';
import { useLocale } from '@/lib/i18n';
import { copy } from '@/lib/labels';
import { applyTheme, currentTheme, themePreferences, type ThemePreference } from '@/lib/theme';
import styles from './theme-panel.module.css';

export function ThemePanel() {
  const { locale } = useLocale(); const c = copy(locale);
  const [theme, setTheme] = useState<ThemePreference>('system');
  useEffect(() => { setTheme(currentTheme()); }, []);
  const choose = (next: ThemePreference) => { setTheme(next); applyTheme(next); };
  const label = (value: ThemePreference) => ({
    system: c('Según el sistema', 'Match the system'),
    light: c('Claro', 'Light'),
    dark: c('Oscuro', 'Dark'),
  })[value];
  return <section aria-labelledby="theme-heading"><Card className="form-card">
    <h2 id="theme-heading">{c('Apariencia', 'Appearance')}</h2>
    <p>{c('Elige el tema de la app en este equipo. «Según el sistema» cambia solo cuando tu equipo pasa a modo claro u oscuro.', 'Choose the app theme on this device. “Match the system” switches when your device changes between light and dark mode.')}</p>
    <fieldset className={styles.choices}>
      <legend className="sr-only">{c('Tema', 'Theme')}</legend>
      {themePreferences.map((value) => <label className={styles.choice} key={value}>
        <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => choose(value)}/> {label(value)}
      </label>)}
    </fieldset>
  </Card></section>;
}
