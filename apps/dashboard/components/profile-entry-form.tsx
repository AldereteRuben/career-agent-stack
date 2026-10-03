'use client';

import { useState, type FormEvent } from 'react';
import type { StructuredEntry } from '@career/domain';
import { useLocale } from '@/lib/i18n';
import { copy, labelFor, selectableFactKinds } from '@/lib/labels';
import { Button, Field, Notice, SelectField, TextareaField } from './ui';

export type ProfileEntry = { id: string; kind: string; statement: string; tags: string[]; details?: StructuredEntry | null };
export type EntryInput = { kind: string; statement: string; tags: string[]; employment?: { role: string; company: string; startMonth: string; endMonth?: string; current: boolean; locale: 'es' | 'en' }; education?: { qualification: string; institution: string; startMonth: string; endMonth?: string; current: boolean; locale: 'es' | 'en' } };

export function ProfileEntryForm({ initial, busy, blocked = false, onSave, onCancel, onDirtyChange }: { initial?: ProfileEntry; busy: boolean; blocked?: boolean; onSave: (input: EntryInput) => Promise<boolean>; onCancel?: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const { locale } = useLocale(); const c = copy(locale);
  const empty = () => ({ kind: 'experience', title: '', organization: '', startMonth: '', endMonth: '', current: false, description: '', tags: '' });
  const [draft, setDraft] = useState(() => initial ? { kind: initial.kind, title: initial.details?.title ?? '', organization: initial.details?.organization ?? '', startMonth: initial.details?.startMonth ?? '', endMonth: initial.details?.endMonth ?? '', current: initial.details?.current ?? false, description: initial.details?.description ?? initial.statement, tags: initial.tags.join(', ') } : empty());
  const [plain, setPlain] = useState(Boolean(initial && !initial.details));
  const structured = !plain && ['experience', 'education'].includes(draft.kind);
  const study = draft.kind === 'education';
  const example = study ? c('Por ejemplo: especialidad en diseño de servicios…', 'For example: specialism in service design…') : draft.kind === 'skill_evidence' ? c('Por ejemplo: usé Excel para organizar el inventario semanal…', 'For example: used Excel to manage the weekly inventory…') : draft.kind === 'project' ? c('Por ejemplo: creé una web de reservas y diseñé sus formularios…', 'For example: built a booking website and designed its forms…') : c('Por ejemplo: coordiné las entregas y resolví incidencias con clientes…', 'For example: coordinated deliveries and resolved customer issues…');
  const update = (patch: Partial<typeof draft>) => { setDraft((current) => ({ ...current, ...patch })); onDirtyChange?.(true); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const dates = { startMonth: draft.startMonth, ...(draft.current ? {} : { endMonth: draft.endMonth }), current: draft.current, locale };
    const input: EntryInput = { kind: draft.kind, statement: draft.description.trim(), tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean), ...(structured ? study ? { education: { qualification: draft.title.trim(), institution: draft.organization.trim(), ...dates } } : { employment: { role: draft.title.trim(), company: draft.organization.trim(), ...dates } } : {}) };
    if (await onSave(input)) { setDraft(empty()); onDirtyChange?.(false); }
  };
  return <form className="form-stack entry-form" onSubmit={(event) => void save(event)} aria-busy={busy}>
    <fieldset disabled={busy || blocked} className="entry-fields">
      {!initial && <SelectField label={c('Qué quieres añadir', 'What would you like to add')} value={draft.kind} onChange={(event) => update({ kind: event.target.value })}>{selectableFactKinds.map((kind) => <option key={kind} value={kind}>{labelFor.factKind(kind, locale)}</option>)}</SelectField>}
      {plain && ['experience', 'education'].includes(draft.kind) && <Notice role={null} actions={<Button type="button" variant="secondary" onClick={() => { setPlain(false); onDirtyChange?.(true); }}>{c('Completar campos y fechas', 'Complete fields and dates')}</Button>}>{c('Esta entrada se guardó como texto. Puedes conservarla así o completar sus campos sin perder el contenido.', 'This entry was saved as text. Keep it as it is, or complete its fields without losing the content.')}</Notice>}
      {structured && <fieldset className="profile-fieldset"><legend>{study ? c('Datos de tus estudios', 'Education details') : c('Datos del empleo', 'Employment details')}</legend><div className="form-grid">
        <Field name="entry-title" label={study ? c('Titulación o curso', 'Qualification or course') : c('Puesto que ocupaste', 'Job title')} value={draft.title} onChange={(event) => update({ title: event.target.value })} required maxLength={200} autoComplete="off"/>
        <Field name="entry-organization" label={study ? c('Centro o institución', 'School or institution') : c('Empresa', 'Company')} value={draft.organization} onChange={(event) => update({ organization: event.target.value })} required maxLength={200} autoComplete="off"/>
        <Field name="entry-start" label={c('Fecha de inicio', 'Start date')} type="month" value={draft.startMonth} onChange={(event) => update({ startMonth: event.target.value })} required min="1000-01" max="9999-12" hint={c('Mes y año.', 'Month and year.')}/>
        {!draft.current && <Field name="entry-end" label={c('Fecha de fin', 'End date')} type="month" value={draft.endMonth} onChange={(event) => update({ endMonth: event.target.value })} required min={draft.startMonth || '1000-01'} max="9999-12" hint={c('Mes y año.', 'Month and year.')}/>}
        <label className="checkbox-line field-span"><input type="checkbox" checked={draft.current} onChange={(event) => update({ current: event.target.checked })}/><span>{study ? c('Actualmente estudio aquí', 'I currently study here') : c('Actualmente trabajo aquí', 'I currently work here')}</span></label>
      </div></fieldset>}
      <TextareaField name="entry-description" placeholder={example} label={plain && initial ? c('Texto completo para el CV', 'Full resume text') : study ? c('Detalles de tus estudios (opcional)', 'Education details (optional)') : c('Describe tu experiencia o logro', 'Describe your experience or achievement')} value={draft.description} onChange={(event) => update({ description: event.target.value })} required={!structured || !study} rows={4} maxLength={structured ? 3500 : 4000} hint={structured ? study ? c('Puedes incluir especialidad, proyecto final o distinciones que puedas confirmar.', 'You can include your specialism, final project, or distinctions you can confirm.') : c('Cuenta qué hacías y qué conseguiste. El puesto, la empresa y las fechas se añaden desde los campos de arriba.', 'Describe your work and achievements. The role, employer, and dates come from the fields above.') : c('Escribe solo información que puedas confirmar.', 'Only enter information you can confirm.')}/>
      <details className="profile-tags"><summary>{c('Palabras clave · opcional', 'Keywords · optional')}</summary><Field name="entry-tags" label={initial ? c('Palabras clave del texto', 'Entry keywords') : c('Palabras clave', 'Keywords')} value={draft.tags} onChange={(event) => update({ tags: event.target.value })} hint={c('Separa con comas. No se imprimen como etiquetas en el PDF.', 'Separate with commas. These are not printed as tags in the PDF.')}/></details>
      <p className="muted-label">{initial ? c('Revisa y confirma la corrección después de guardarla. Los PDF anteriores conservarán su contenido.', 'Review and confirm the correction after saving. Earlier PDFs will keep their content.') : c('Después de guardar, revisa el texto y pulsa Confirmar para poder usarlo en tu CV.', 'After saving, review the text and select Confirm to use it in your resume.')}</p>
      <div className="form-submit"><Button type="submit">{busy ? c('Guardando…', 'Saving…') : initial ? c('Guardar corrección para revisar', 'Save correction for review') : c('Añadir para revisar', 'Add for review')}</Button></div>
    </fieldset>
    {onCancel && <Button type="button" variant="quiet" disabled={busy} onClick={onCancel}>{c('Cancelar edición', 'Cancel editing')}</Button>}
  </form>;
}
