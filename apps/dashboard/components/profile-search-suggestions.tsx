'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { normalizeWorkMode } from '@/lib/labels';
import type { SearchDraft } from '@/components/search-types';
import styles from '@/app/searches/searches.module.css';

type ProfileResponse = {
  profile?: {
    preferences?: {
      targetTitles?: unknown;
      workModes?: unknown;
    };
  };
};

type Props = {
  t: (es: string, en: string) => string;
  onSelect: (role: string, workMode?: SearchDraft['workMode']) => void;
};

const workModeValues = new Set<SearchDraft['workMode']>(['remote', 'hybrid', 'onsite']);

function cleanStrings(value: unknown, maxLength: number) {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const label = item.trim();
    if (!label || label.length > maxLength) continue;
    const key = label.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, label);
  }
  return [...unique.values()];
}

export function ProfileSearchSuggestions({ t, onSelect }: Props) {
  const [suggestions, setSuggestions] = useState<{ titles: string[]; workModes: SearchDraft['workMode'][] }>({ titles: [], workModes: [] });

  useEffect(() => {
    const controller = new AbortController();
    void api<ProfileResponse>('/profile', { signal: controller.signal }).then((data) => {
      const preferences = data.profile?.preferences;
      const titles = cleanStrings(preferences?.targetTitles, 200);
      const workModes = cleanStrings(preferences?.workModes, 40)
        .map(normalizeWorkMode)
        .filter((mode): mode is SearchDraft['workMode'] => workModeValues.has(mode as SearchDraft['workMode']));
      setSuggestions({ titles, workModes });
    }).catch(() => {
      // Profile suggestions are optional; the manual search form remains available.
    });
    return () => controller.abort();
  }, []);

  if (suggestions.titles.length === 0) return null;
  const preferredWorkMode = suggestions.workModes.length === 1 ? suggestions.workModes[0] : undefined;

  return <section className={styles.form} aria-label={t('Puestos de tu perfil', 'Roles from your profile')}>
    <p className={styles.intro}>{preferredWorkMode
      ? t('Elige un puesto de tu perfil. También añadiremos la única modalidad que tienes guardada. Revisa los filtros y pulsa «Buscar ofertas» para iniciar la búsqueda.', 'Choose a role from your profile. We will also add the only work mode you have saved. Review the filters and choose “Find jobs” to start searching.')
      : t('Empieza con un puesto que ya guardaste en tu perfil. Revisa los filtros y pulsa «Buscar ofertas» para iniciar la búsqueda.', 'Start with a role you already saved in your profile. Review the filters and choose “Find jobs” to start searching.')}</p>
    <div className={styles.actions}>
      {suggestions.titles.map((title) => <Button key={title} type="button" variant="secondary" onClick={() => onSelect(title, preferredWorkMode)}>{title}</Button>)}
    </div>
  </section>;
}
