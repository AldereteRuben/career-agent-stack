'use client';

import { useEffect, useState, type FormEvent, type RefObject } from 'react';
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
  /** The provider set a new search starts with; used to tell whether options were changed. */
  defaultProviders: ProviderId[];
  t: (es: string, en: string) => string;
};

const providers: Array<{ id: ProviderId; es: string; en: string }> = [
  { id: 'remotive', es: 'Remotive', en: 'Remotive' },
  { id: 'arbeitnow', es: 'Arbeitnow', en: 'Arbeitnow' },
  { id: 'himalayas', es: 'Himalayas', en: 'Himalayas' },
  { id: 'boards', es: 'Empresas que sigues', en: 'Companies you follow' },
];

/** Disclosures that hold changed values open themselves; the person can still close them. */
function hiddenChanges(draft: SearchDraft, defaults: ProviderId[], oldMatcher: boolean) {
  const sameProviders = draft.providerIds.length === defaults.length && defaults.every((id) => draft.providerIds.includes(id));
  return {
    placement: Boolean(draft.company) || draft.workMode !== 'any',
    options: oldMatcher || !sameProviders || draft.includeRelated || draft.frequencyHours !== 24 || !draft.enabled || draft.autoPrepare,
  };
}

/**
 * First search asks for two things only: what job and, optionally, where. Company and work mode sit
 * behind a clearly named disclosure (company-only search stays one click away); schedule, portals and
 * preparation stay in a separate closed one.
 */
export function SearchForm(props: Props) {
  const { draft, editing, busy, ready, formError, criteriaMissing, titleRef, onDraftChange, onSubmit, onDismissDraft, t } = props;
  const oldMatcher = Boolean(editing && props.existingSearch?.matcherVersion === 1);
  // Controlled so typing never resets them; seeded (and later only widened) from values that differ from the defaults.
  const [placementOpen, setPlacementOpen] = useState(() => hiddenChanges(draft, props.defaultProviders, oldMatcher).placement);
  const [optionsOpen, setOptionsOpen] = useState(() => hiddenChanges(draft, props.defaultProviders, oldMatcher).options);
  useEffect(() => {
    if (!ready) return;
    const changed = hiddenChanges(draft, props.defaultProviders, oldMatcher);
    if (changed.placement) setPlacementOpen(true);
    if (changed.options) setOptionsOpen(true);
    // A restored draft arrives once storage is ready; afterwards the person controls the disclosures.
  }, [ready, editing]);
  const criteriaKeys: Array<keyof SearchDraft> = ['role', 'company', 'location', 'workMode', 'providerIds', 'matcherVersion', 'includeRelated'];
  const update = (next: SearchDraft, key: keyof SearchDraft) => {
    if (props.existingSearch?.autoPrepare && criteriaKeys.includes(key)) next.autoPrepare = false;
    onDraftChange(next);
  };
  const change = <K extends keyof SearchDraft>(key: K, value: SearchDraft[K]) => update({ ...draft, [key]: value }, key);
  const toggleProvider = (provider: ProviderId, checked: boolean) => change('providerIds', checked
    ? [...new Set([...draft.providerIds, provider])]
    : draft.providerIds.filter((item) => item !== provider));
  const editName = props.existingSearch ? [props.existingSearch.role, props.existingSearch.company].filter(Boolean).join(' · ') : '';
  const sendsQuery = (!oldMatcher || draft.improveMatching) && draft.providerIds.includes('himalayas');
  const disabled = busy || !ready;
  const describedBy = formError ? 'search-form-error' : undefined;

  return <section className={styles.formColumn} aria-labelledby="search-form-title">
    <Card className={styles.formCard}>
      <h2 id="search-form-title" ref={titleRef} tabIndex={-1}>{editing ? `${t('Editar búsqueda', 'Edit search')}${editName ? `: ${editName}` : ''}` : t('¿Qué trabajo buscas?', 'What job are you looking for?')}</h2>
      <p className={styles.intro}>{editing
        ? t('Los cambios se aplican a esta búsqueda; no se crea otra.', 'Changes apply to this search; no new search is created.')
        : draft.enabled
          ? t(`Buscaremos ofertas ahora y repetiremos la búsqueda cada ${draft.frequencyHours} horas mientras Career Stack siga en marcha en este ordenador, aunque cierres el navegador. No necesitas perfil ni CV.`, `We will look for jobs now and repeat the search every ${draft.frequencyHours} hours while Career Stack keeps running on this computer, even if you close the browser. No profile or resume needed.`)
          : t('Esta búsqueda se guardará en pausa: no buscaremos ofertas hasta que la reanudes.', 'This search will be saved paused: we will not look for jobs until you resume it.')}</p>
      {props.storageFailed && (draft.role || draft.company || draft.location) && <Notice tone="warning">{t('No se pudo conservar el borrador. Guárdalo antes de salir.', 'The draft could not be kept. Save it before leaving.')}</Notice>}
      <form onSubmit={onSubmit} className={styles.form} data-search-form={editing ? 'edit' : 'create'}>
        {formError && <div id="search-form-error" tabIndex={-1} className={styles.formError}><Notice tone="error">{formError}</Notice></div>}
        <Field disabled={disabled} id="search-role" name="role" aria-invalid={criteriaMissing || draft.role.trim().length > 200 || undefined} aria-describedby={describedBy} label={t('Puesto o palabras clave', 'Role or keywords')} value={draft.role} onChange={(event) => update({ ...draft, role: event.target.value }, 'role')} placeholder={t('Ej.: Product Designer', 'e.g. product designer')} />
        <Field disabled={disabled} id="search-location" aria-invalid={draft.location.trim().length > 200 || undefined} aria-describedby={describedBy} label={t('País o ubicación (opcional)', 'Country or location (optional)')} value={draft.location} onChange={(event) => update({ ...draft, location: event.target.value }, 'location')} placeholder={t('Ej.: Berlín o España', 'e.g. Berlin or Spain')} />
        <details id="search-placement" className={styles.moreOptions} open={placementOpen} onToggle={(event) => setPlacementOpen(event.currentTarget.open)}>
          <summary>{t('Añadir empresa o modalidad', 'Add company or work mode')}</summary>
          <div className={styles.form}>
            <p className={styles.automationHint}>{t('Para buscar solo en una empresa, escribe su nombre y deja el puesto vacío.', 'To search one company only, enter its name and leave the role empty.')}</p>
            <Field disabled={disabled} id="search-company" aria-invalid={draft.company.trim().length > 200 || undefined} aria-describedby={describedBy} label={t('Empresa (opcional)', 'Company (optional)')} value={draft.company} onChange={(event) => update({ ...draft, company: event.target.value }, 'company')} placeholder={t('Ej.: Northwind', 'e.g. Northwind')} />
            <SelectField disabled={disabled} id="search-workMode" label={t('Modalidad', 'Work mode')} value={draft.workMode} onChange={(event) => change('workMode', event.target.value as SearchDraft['workMode'])}><option value="any">{t('Cualquiera', 'Any')}</option><option value="remote">{t('En remoto', 'Remote')}</option><option value="hybrid">{t('Híbrida', 'Hybrid')}</option><option value="onsite">{t('Presencial', 'On-site')}</option></SelectField>
          </div>
        </details>
        <details id="search-options" className={styles.moreOptions} open={optionsOpen} onToggle={(event) => setOptionsOpen(event.currentTarget.open)}>
          <summary>{t('Portales, frecuencia y opciones', 'Portals, frequency and options')}</summary>
          <div className={styles.form}>
            {oldMatcher && <label className={styles.check}><input type="checkbox" disabled={disabled} checked={draft.improveMatching} onChange={(event) => update({ ...draft, improveMatching: event.target.checked, matcherVersion: event.target.checked ? 2 : 1 }, 'matcherVersion')} /><span>{t('Probar coincidencias mejoradas y fuentes nuevas', 'Use improved matching and newer sources')}<small>{t('La búsqueda antigua conserva sus reglas y fuentes hasta que marques esta opción.', 'This search keeps its old matching rules and sources unless you choose this option.')}</small></span></label>}
            {(!oldMatcher || draft.improveMatching) && <fieldset className={styles.providerFieldset} disabled={disabled}>
              <legend>{t('Portales donde buscamos', 'Job portals we search')}</legend>
              <p className={styles.automationHint}>{t('Portales de empleo con ofertas públicas. Himalayas es un portal de empleo en remoto: si lo incluyes, recibe solo el puesto, la empresa o el país que escribas; nunca tu CV ni tus datos de contacto.', 'Job portals with public listings. Himalayas is a remote-jobs portal: if you include it, it receives only the role, company or country you enter; never your resume or contact details.')}</p>
              <div className={styles.providerOptions}>{providers.map((provider) => <label className={styles.check} key={provider.id}><input type="checkbox" id={`search-provider-${provider.id}`} checked={draft.providerIds.includes(provider.id)} onChange={(event) => toggleProvider(provider.id, event.target.checked)} /><span>{t(provider.es, provider.en)}</span></label>)}</div>
              <label className={styles.check}><input type="checkbox" checked={draft.includeRelated} onChange={(event) => change('includeRelated', event.target.checked)} /><span>{t('Incluir puestos relacionados', 'Include related roles')}<small>{t('Los mostraremos identificados para que decidas si encajan.', 'We label them so you can decide whether they fit.')}</small></span></label>
            </fieldset>}
            <SelectField disabled={disabled} label={t('Frecuencia de actualización', 'Refresh frequency')} value={draft.frequencyHours} onChange={(event) => change('frequencyHours', Number(event.target.value) as SearchDraft['frequencyHours'])}><option value={6}>{t('Cada 6 horas', 'Every 6 hours')}</option><option value={12}>{t('Cada 12 horas', 'Every 12 hours')}</option><option value={24}>{t('Cada 24 horas', 'Every 24 hours')}</option></SelectField>
            <label className={styles.check}><input type="checkbox" disabled={disabled} checked={draft.enabled} onChange={(event) => change('enabled', event.target.checked)} /><span>{t('Actualizar esta búsqueda automáticamente', 'Refresh this search automatically')}</span></label>
            <label className={styles.check}><input type="checkbox" disabled={disabled} checked={draft.autoPrepare} onChange={(event) => change('autoPrepare', event.target.checked)} /><span>{t('Preparar también un CV para cada coincidencia', 'Also prepare a resume for each match')}<small>{draft.matcherVersion === 2 ? t('Opcional: hasta 5 candidaturas en cada consulta y 10 al día. Siempre revisarás el CV antes de enviarlo.', 'Optional: up to 5 applications per check and 10 per day. You always review the resume before submitting it.') : t('Opcional. Siempre revisarás el CV antes de enviarlo.', 'Optional. You always review the resume before submitting it.')}{props.existingSearch?.autoPrepare && <>{' '}{t('Si cambias los criterios, vuelve a activar esta opción para confirmarlo.', 'If you change the criteria, turn this on again to confirm.')}</>}</small></span></label>
          </div>
        </details>
        {editing && <p className={styles.automationHint}>{draft.enabled ? t(`Se repetirá cada ${draft.frequencyHours} horas mientras Career Stack siga en marcha en este ordenador.`, `It repeats every ${draft.frequencyHours} hours while Career Stack keeps running on this computer.`) : t('Esta búsqueda quedará en pausa.', 'This search will stay paused.')}</p>}
        <p id="search-sharing" className={styles.automationHint} role="note">{sendsQuery
          ? t('Al buscar, descargamos ofertas públicas de portales de empleo y las filtramos en este ordenador. Un portal de empleo en remoto recibe lo que escribas (puesto, empresa o país) para buscar; nunca tu CV ni tus datos de contacto. Puedes quitarlo en «Portales, frecuencia y opciones».', 'To search, we download public listings from job portals and filter them on this computer. One remote-jobs portal receives what you enter (role, company or country) to search; never your resume or contact details. You can remove it under “Portals, frequency and options”.')
          : t('Al buscar, descargamos ofertas públicas de portales de empleo y las filtramos en este ordenador; los portales no reciben lo que escribes ni tu CV.', 'To search, we download public listings from job portals and filter them on this computer; the portals do not receive what you enter or your resume.')}</p>
        <div className={styles.actions}><Button type="submit" disabled={disabled}>{busy ? t(editing ? 'Guardando…' : 'Buscando…', editing ? 'Saving…' : 'Searching…') : t(editing ? 'Guardar cambios' : 'Buscar ofertas', editing ? 'Save changes' : 'Find jobs')}</Button>{props.hasSearches && <Button type="button" variant="quiet" disabled={disabled} onClick={onDismissDraft}>{editing ? t('Cancelar edición', 'Cancel editing') : t('Descartar borrador', 'Discard draft')}</Button>}</div>
      </form>
    </Card>
  </section>;
}
