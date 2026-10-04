'use client';

import type { FormEvent, RefObject } from 'react';
import { Button, Card, Field, Notice, SelectField } from '@/components/ui';
import type { ProviderId, Search, SearchDraft } from '@/components/search-types';
import styles from '@/app/searches/searches.module.css';

type Props = {
  draft: SearchDraft;
  editing: string;
  existingSearch?: Search;
  busy: boolean;
  ready: boolean;
  storageFailed: boolean;
  formError: string;
  criteriaMissing: boolean;
  invalidField: string | null;
  titleRef: RefObject<HTMLHeadingElement | null>;
  onDraftChange: (next: SearchDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onDismissDraft: () => void;
  hasSearches: boolean;
  t: (es: string, en: string) => string;
};

const providers: Array<{ id: ProviderId; es: string; en: string }> = [
  { id: 'remotive', es: 'Remotive', en: 'Remotive' },
  { id: 'arbeitnow', es: 'Arbeitnow', en: 'Arbeitnow' },
  { id: 'himalayas', es: 'Himalayas', en: 'Himalayas' },
  { id: 'boards', es: 'Empresas que sigues', en: 'Companies you follow' },
];

export function SearchForm(props: Props) {
  const { draft, editing, busy, ready, formError, criteriaMissing, titleRef, onDraftChange, onSubmit, onDismissDraft, t } = props;
  const criteriaKeys: Array<keyof SearchDraft> = ['role', 'company', 'location', 'workMode', 'providerIds', 'matcherVersion', 'includeRelated'];
  const update = (next: SearchDraft, key: keyof SearchDraft) => {
    if (props.existingSearch?.autoPrepare && criteriaKeys.includes(key)) next.autoPrepare = false;
    onDraftChange(next);
  };
  const change = <K extends keyof SearchDraft>(key: K, value: SearchDraft[K]) => update({ ...draft, [key]: value }, key);
  const toggleProvider = (provider: ProviderId, checked: boolean) => change('providerIds', checked
    ? [...new Set([...draft.providerIds, provider])]
    : draft.providerIds.filter((item) => item !== provider));
  const oldMatcher = Boolean(editing && props.existingSearch?.matcherVersion === 1);
  const editName = props.existingSearch ? [props.existingSearch.role, props.existingSearch.company].filter(Boolean).join(' · ') : '';

  return <section className={styles.formColumn} aria-labelledby="search-form-title">
    <Card className={styles.formCard}>
      <h2 id="search-form-title" ref={titleRef} tabIndex={-1}>{editing ? `${t('Editar búsqueda', 'Edit search')}${editName ? `: ${editName}` : ''}` : t('¿Qué trabajo buscas?', 'What job are you looking for?')}</h2>
      <p className={styles.intro}>{editing ? t('Los cambios se aplican a esta búsqueda; no se crea otra.', 'Changes apply to this search; no new search is created.') : t('Indica un puesto, una empresa o ambos. Buscaremos ofertas por ti; no necesitas perfil ni CV.', 'Enter a role, a company, or both. We will look for jobs for you; no profile or resume needed.')}</p>
      {props.storageFailed && (draft.role || draft.company || draft.location) && <Notice tone="warning">{t('No se pudo conservar el borrador. Guárdalo antes de salir.', 'The draft could not be kept. Save it before leaving.')}</Notice>}
      <form onSubmit={onSubmit} className={styles.form}>
        {formError && <div id="search-form-error" tabIndex={-1} className={styles.formError}><Notice tone="error">{formError}</Notice></div>}
        <Field disabled={busy || !ready} id="search-role" name="role" aria-invalid={criteriaMissing || draft.role.trim().length > 200 || undefined} aria-describedby={formError ? 'search-form-error' : undefined} label={t('Puesto o palabras clave', 'Role or keywords')} value={draft.role} onChange={(event) => update({ ...draft, role: event.target.value }, 'role')} placeholder={t('Ej.: Product Designer', 'e.g. product designer')} hint={t('Máximo 200 caracteres por campo. También puedes buscar solo por empresa.', 'Up to 200 characters per field. You can also search by company alone.')} />
        <Field disabled={busy || !ready} id="search-company" aria-invalid={draft.company.trim().length > 200 || undefined} aria-describedby={formError ? 'search-form-error' : undefined} label={t('Empresa (opcional)', 'Company (optional)')} value={draft.company} onChange={(event) => update({ ...draft, company: event.target.value }, 'company')} placeholder={t('Ej.: Northwind', 'e.g. Northwind')} />
        <Field disabled={busy || !ready} id="search-location" aria-invalid={draft.location.trim().length > 200 || undefined} aria-describedby={formError ? 'search-form-error' : undefined} label={t('País o ubicación (opcional)', 'Country or location (optional)')} value={draft.location} onChange={(event) => update({ ...draft, location: event.target.value }, 'location')} placeholder={t('Ej.: Berlín o España', 'e.g. Berlin or Spain')} />
        <SelectField disabled={busy || !ready} label={t('Modalidad', 'Work mode')} value={draft.workMode} onChange={(event) => change('workMode', event.target.value as SearchDraft['workMode'])}><option value="any">{t('Cualquiera', 'Any')}</option><option value="remote">{t('En remoto', 'Remote')}</option><option value="hybrid">{t('Híbrida', 'Hybrid')}</option><option value="onsite">{t('Presencial', 'On-site')}</option></SelectField>
        <details className={styles.moreOptions} key={editing || 'new'} open={editing ? true : undefined}>
          <summary>{t('Portales, frecuencia y opciones', 'Portals, frequency and options')}</summary>
          <div className={styles.form}>
            {oldMatcher && <label className={styles.check}><input type="checkbox" disabled={busy || !ready} checked={draft.improveMatching} onChange={(event) => update({ ...draft, improveMatching: event.target.checked, matcherVersion: event.target.checked ? 2 : 1 }, 'matcherVersion')} /><span>{t('Probar coincidencias mejoradas y fuentes nuevas', 'Use improved matching and newer sources')}<small>{t('La búsqueda antigua conserva sus reglas y fuentes hasta que marques esta opción.', 'This search keeps its old matching rules and sources unless you choose this option.')}</small></span></label>}
            {(!oldMatcher || draft.improveMatching) && <fieldset className={styles.providerFieldset} disabled={busy || !ready}>
              <legend>{t('Portales donde buscamos', 'Job portals we search')}</legend>
              <p className={styles.automationHint}>{t('Portales de empleo con ofertas públicas. Himalayas es un portal de empleo en remoto: si lo incluyes, recibe solo el puesto, la empresa o el país que escribas; nunca tu CV ni tus datos de contacto.', 'Job portals with public listings. Himalayas is a remote-jobs portal: if you include it, it receives only the role, company or country you enter; never your resume or contact details.')}</p>
              <div className={styles.providerOptions}>{providers.map((provider) => <label className={styles.check} key={provider.id}><input type="checkbox" checked={draft.providerIds.includes(provider.id)} onChange={(event) => toggleProvider(provider.id, event.target.checked)} /><span>{t(provider.es, provider.en)}</span></label>)}</div>
              <label className={styles.check}><input type="checkbox" checked={draft.includeRelated} onChange={(event) => change('includeRelated', event.target.checked)} /><span>{t('Incluir puestos relacionados', 'Include related roles')}<small>{t('Los mostraremos identificados para que decidas si encajan.', 'We label them so you can decide whether they fit.')}</small></span></label>
            </fieldset>}
            <SelectField disabled={busy || !ready} label={t('Frecuencia de actualización', 'Refresh frequency')} value={draft.frequencyHours} onChange={(event) => change('frequencyHours', Number(event.target.value) as SearchDraft['frequencyHours'])}><option value={6}>{t('Cada 6 horas', 'Every 6 hours')}</option><option value={12}>{t('Cada 12 horas', 'Every 12 hours')}</option><option value={24}>{t('Cada 24 horas', 'Every 24 hours')}</option></SelectField>
            <label className={styles.check}><input type="checkbox" disabled={busy || !ready} checked={draft.enabled} onChange={(event) => change('enabled', event.target.checked)} /><span>{t('Actualizar esta búsqueda automáticamente', 'Refresh this search automatically')}</span></label>
            <label className={styles.check}><input type="checkbox" disabled={busy || !ready} checked={draft.autoPrepare} onChange={(event) => change('autoPrepare', event.target.checked)} /><span>{t('Preparar también un CV para cada coincidencia', 'Also prepare a resume for each match')}<small>{draft.matcherVersion === 2 ? t('Opcional: hasta 5 candidaturas en cada consulta y 10 al día. Siempre revisarás el CV antes de enviarlo.', 'Optional: up to 5 applications per check and 10 per day. You always review the resume before submitting it.') : t('Opcional. Siempre revisarás el CV antes de enviarlo.', 'Optional. You always review the resume before submitting it.')}{props.existingSearch?.autoPrepare && <>{' '}{t('Si cambias los criterios, vuelve a activar esta opción para confirmarlo.', 'If you change the criteria, turn this on again to confirm.')}</>}</small></span></label>
          </div>
        </details>
        <p className={styles.automationHint}>{draft.enabled ? t(`Buscaremos ahora y después cada ${draft.frequencyHours} horas. Puedes cerrar la pestaña: seguiremos buscando mientras Career Stack siga en marcha en este ordenador.`, `We will search now and then every ${draft.frequencyHours} hours. You can close the tab: we keep searching while Career Stack keeps running on this computer.`) : t('Esta búsqueda se guardará en pausa.', 'This search will be saved paused.')}</p>
        {draft.providerIds.includes('himalayas') && <p className={styles.automationHint} role="note">{t('Al guardar, Himalayas recibe solo el puesto, la empresa o la ubicación; nunca tu CV ni tus datos de contacto.', 'When you save, Himalayas receives only the role, company or location; never your resume or contact details.')}</p>}
        <div className={styles.actions}><Button type="submit" disabled={busy || !ready}>{busy ? t('Guardando…', 'Saving…') : t(editing ? 'Guardar cambios' : 'Buscar y guardar', editing ? 'Save changes' : 'Search and save')}</Button>{props.hasSearches && <Button type="button" variant="quiet" disabled={busy || !ready} onClick={onDismissDraft}>{editing ? t('Cancelar edición', 'Cancel editing') : t('Descartar borrador', 'Discard draft')}</Button>}</div>
        {ready && !props.storageFailed && <p className={styles.draftHint}>{t('Lo que escribas se conserva en esta pestaña hasta que lo guardes o cierres sesión.', 'What you type is kept in this tab until you save it or sign out.')}</p>}
      </form>
    </Card>
  </section>;
}
