'use client';

import { useLocale } from '@/lib/i18n';
import { Card } from '@/components/ui';

type BreakdownGroup = {
  key: string;
  label: string;
  confirmed: number;
  interviewed: number;
  interviewConversionPercent: number | null;
  smallSample: boolean;
};

type Breakdowns = { source: BreakdownGroup[]; role: BreakdownGroup[]; country: BreakdownGroup[] };

function sourceLabel(key: string, c: (es: string, en: string) => string) {
  if (key === 'multiple') return c('Varias fuentes', 'Multiple sources');
  if (key === 'unidentified') return c('Sin fuente identificada', 'Source not identified');
  const providers: Record<string, string> = {
    greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', remotive: 'Remotive', arbeitnow: 'Arbeitnow',
  };
  return providers[key] ?? key;
}

export function ApplicationPatterns({ breakdowns }: { breakdowns: Breakdowns }) {
  const { locale } = useLocale();
  const c = (es: string, en: string) => locale === 'es' ? es : en;
  const sections = [
    { key: 'source', title: c('Por fuente', 'By source'), groups: breakdowns.source },
    { key: 'role', title: c('Por puesto', 'By role'), groups: breakdowns.role },
    { key: 'country', title: c('Por país', 'By country'), groups: breakdowns.country },
  ];

  if (sections.every((section) => section.groups.length === 0)) return null;

  return <div className="home-grid application-patterns">
    {sections.map((section) => <Card key={section.key} className="home-panel" aria-labelledby={`application-pattern-${section.key}`}>
      <h3 id={`application-pattern-${section.key}`}>{section.title}</h3>
      {section.key === 'country' && <p className="panel-status">{c('La ubicación se guarda como texto libre; no inferimos el país.', 'Location is stored as free text, so we do not infer a country.')}</p>}
      <ul className="row-list" aria-label={section.title}>
        {section.groups.map((group) => {
          const label = section.key === 'source'
            ? sourceLabel(group.key, c)
            : section.key === 'country' && group.key === 'unidentified'
              ? c('País no identificado', 'Country not identified')
              : group.label;
          const conversion = group.smallSample
            ? c('Muestra pequeña', 'Small sample')
            : `${group.interviewConversionPercent}%`;
          return <li key={group.key} className="list-row">
            <span className="row-main">
              <strong>{label}</strong>
              <span>{group.confirmed} {c('solicitudes', 'applications')} · {group.interviewed} {c('entrevistas', 'interviews')}</span>
            </span>
            <span className="tag tag-neutral" aria-label={group.smallSample ? c('Porcentaje oculto por muestra pequeña', 'Percentage hidden for small sample') : c('Conversión a entrevista', 'Interview conversion')}>
              {conversion}
            </span>
          </li>;
        })}
      </ul>
    </Card>)}
  </div>;
}
