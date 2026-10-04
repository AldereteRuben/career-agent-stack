'use client';

import type { AiArtifactState, AiOperation, AiOutput } from '@career/domain';
import { useState } from 'react';
import { Button, Notice, Tag } from '@/components/ui';
import { useLocale, type Locale } from '@/lib/i18n';
import { copy, labelFor } from '@/lib/labels';
import styles from './draft-action.module.css';

export type AiPreviewSources = {
  searchRequest?: string;
  job?: string;
  facts: Array<{ factId: string; kind: string; text: string }>;
  question?: string;
};
export type AiArtifact = { id: string; revision: number; state: AiArtifactState; operation: AiOperation; output: AiOutput; sources: AiPreviewSources };

function Evidence({ quotes = [], factIds = [], sources, locale }: { quotes?: Array<{ quote: string }>; factIds?: string[]; sources: AiPreviewSources; locale: Locale }) {
  const c = copy(locale);
  if (!quotes.length && !factIds.length) return null;
  const facts = [...new Set(factIds)].map(id => sources.facts.find(fact => fact.factId === id));
  return <details className={styles.evidence}>
    <summary>{c('Ver en qué se basa', 'See the supporting information')}</summary>
    <div className={styles.sourceBody}>
      {quotes.length > 0 && <div className={styles.section}><strong>{c('Texto de la oferta', 'Job posting text')}</strong>{quotes.map((item, index) => <blockquote className={styles.source} key={index}>{item.quote}</blockquote>)}</div>}
      {facts.length > 0 && <div className={styles.section}><strong>{c('Datos que confirmaste', 'Details you confirmed')}</strong><ul className={styles.facts}>{facts.map((fact, index) => <li key={fact?.factId ?? index}>{fact ? <div className={styles.fact}><span className={styles.hint}>{labelFor.factKind(fact.kind, locale)}</span><p className={styles.source}>{fact.text}</p></div> : c('No se pudo mostrar uno de los datos de origen. Compruébalo antes de usar esta sugerencia.', 'One supporting detail could not be displayed. Check it before using this suggestion.')}</li>)}</ul></div>}
    </div>
  </details>;
}

function Warnings({ warnings, locale }: { warnings: string[]; locale: Locale }) {
  if (!warnings.length) return null;
  const c = copy(locale);
  return <Notice tone="warning" role={null}><div className={styles.section}><strong>{c('Comprueba estos puntos', 'Check these points')}</strong><ul className={styles.list}>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div></Notice>;
}

/** Displays validated provider output as reviewable content, never as instructions or executable markup. */
export function AiResultView({ artifact, onReview }: { artifact: AiArtifact; onReview?: (artifact: AiArtifact) => void }) {
  const { locale } = useLocale();
  const c = copy(locale);
  const { output, sources } = artifact;
  const [acknowledgedConstraints, setAcknowledgedConstraints] = useState<string | null>(null);
  const constraintReviewKey = `${artifact.id}:${artifact.revision}`;
  const requiresConstraintReview = output.operation === 'SEARCH_DRAFT' && output.unsupportedConstraints.length > 0;
  const titles: Record<AiOperation, string> = {
    SEARCH_DRAFT: c('Tu búsqueda propuesta', 'Your suggested search'), JOB_ANALYSIS: c('La oferta, en pocas palabras', 'The job, at a glance'),
    RESUME_DRAFT: c('Sugerencias para tu CV', 'Suggestions for your resume'), ANSWER_DRAFT: c('Ayuda con esta respuesta', 'Help with this answer'),
  };
  const reviewLabels: Record<AiOperation, string> = {
    SEARCH_DRAFT: c('Revisar y editar la búsqueda', 'Review and edit the search'), JOB_ANALYSIS: c('Continuar con esta oferta', 'Continue with this job'),
    RESUME_DRAFT: c('Revisar las sugerencias para mi CV', 'Review my resume suggestions'), ANSWER_DRAFT: c('Revisar y editar mi respuesta', 'Review and edit my answer'),
  };
  const status = artifact.state === 'STALE' ? c('Datos cambiados', 'Source details changed') : artifact.state === 'DISMISSED' ? c('Descartado', 'Dismissed') : artifact.state === 'ACCEPTED' ? c('Revisado', 'Reviewed') : c('Por revisar', 'Needs review');
  if (artifact.operation !== output.operation) return <Notice tone="error">{c('No se pudo mostrar esta sugerencia. Vuelve a consultar el resultado.', 'This suggestion could not be displayed. Check the result again.')}</Notice>;
  return <section className={styles.result}>
    <div className={styles.heading}><h3>{titles[output.operation]}</h3><Tag tone={artifact.state === 'STALE' ? 'amber' : 'blue'}>{status}</Tag></div>
    <p className={styles.hint}>{c('La IA puede equivocarse. Comprueba la propuesta y sus fuentes antes de usarla. Este resultado no cambia tu perfil ni envía solicitudes.', 'AI can make mistakes. Check the suggestion and its sources before using it. This result does not change your profile or submit applications.')}</p>
    {artifact.state === 'STALE' && <Notice tone="warning" role={null}>{c('Los datos de origen cambiaron. Genera una nueva sugerencia para trabajar con la información actual.', 'The source details changed. Generate a new suggestion using the current information.')}</Notice>}
    <div className={styles.section} lang={output.locale}>
      {output.operation === 'SEARCH_DRAFT' && <>
        <dl className={styles.criteria}>
          <div><dt>{c('Puesto', 'Role')}</dt><dd>{output.criteria.role || c('Sin concretar', 'Not specified')}</dd></div>
          <div><dt>{c('Empresa', 'Company')}</dt><dd>{output.criteria.company || c('Cualquier empresa', 'Any company')}</dd></div>
          <div><dt>{c('Lugar', 'Location')}</dt><dd>{output.criteria.location || c('Sin concretar', 'Not specified')}</dd></div>
          <div><dt>{c('Modalidad', 'Work arrangement')}</dt><dd>{({ any: c('Cualquiera', 'Any'), remote: c('En remoto', 'Remote'), hybrid: c('Híbrido', 'Hybrid'), onsite: c('Presencial', 'On-site') })[output.criteria.workMode]}</dd></div>
        </dl>
        {output.unsupportedConstraints.length > 0 && <Notice tone="warning" role={null}><div className={styles.section}><h4>{c('Estas condiciones requieren revisión manual', 'These conditions need a manual check')}</h4><p>{c('Los filtros de búsqueda no pueden aplicarlas automáticamente.', 'Search filters cannot apply them automatically.')}</p><ul className={styles.list}>{output.unsupportedConstraints.map((constraint, index) => <li key={index}><div className={styles.section}><blockquote className={styles.source}>{constraint.requestQuote}</blockquote><p>{constraint.explanation}</p></div></li>)}</ul></div></Notice>}
        {output.clarifications.length > 0 && <div className={styles.section}><h4>{c('Antes de guardar la búsqueda', 'Before saving your search')}</h4><ul className={styles.list}>{output.clarifications.map((item, index) => <li key={index}>{item.question}</li>)}</ul></div>}
        <p className={styles.hint}>{c('La búsqueda todavía no se ha guardado ni ejecutado.', 'The search has not been saved or run yet.')}</p>
      </>}
      {output.operation === 'JOB_ANALYSIS' && <>
        <ul className={styles.resultList}>{output.summary.map((item, index) => <li className={styles.resultItem} key={index}><p>{item.text}</p><Evidence quotes={item.citations} sources={sources} locale={locale}/></li>)}</ul>
        {output.requirements.length > 0 && <div className={styles.section}><h4>{c('Qué pide la empresa', 'What the employer is looking for')}</h4><ul className={styles.resultList}>{output.requirements.map((item, index) => <li className={styles.resultItem} key={index}><div className={styles.labelRow}><Tag>{item.level === 'REQUIRED' ? c('Requisito', 'Required') : item.level === 'PREFERRED' ? c('Se valora', 'Preferred') : c('Sin aclarar', 'Not specified')}</Tag><p>{item.text}</p></div><Evidence quotes={item.citations} sources={sources} locale={locale}/></li>)}</ul></div>}
        {output.personalMatches.length > 0 && <div className={styles.section}><h4>{c('Dónde encaja tu experiencia', 'Where your experience fits')}</h4><ul className={styles.resultList}>{output.personalMatches.map((item, index) => <li className={styles.resultItem} key={index}><p>{item.text}</p>{item.strength === 'PARTIAL' && <span className={styles.hint}>{c('Coincidencia parcial: conviene comprobarla.', 'Partial match: check the details.')}</span>}<Evidence quotes={item.jobCitations} factIds={item.factIds} sources={sources} locale={locale}/></li>)}</ul></div>}
        {output.gaps.length > 0 && <div className={styles.section}><h4>{c('Lo que falta por comprobar', 'What still needs checking')}</h4><p className={styles.hint}>{c('Que no aparezca en los datos compartidos no significa que no tengas esa experiencia.', 'Something missing from the shared details does not mean you lack that experience.')}</p><ul className={styles.resultList}>{output.gaps.map((item, index) => <li className={styles.resultItem} key={index}><p>{item.text}</p><Evidence quotes={item.jobCitations} sources={sources} locale={locale}/></li>)}</ul></div>}
        <Warnings warnings={output.warnings} locale={locale}/>
      </>}
      {output.operation === 'RESUME_DRAFT' && <>
        <Warnings warnings={output.warnings} locale={locale}/>
        <ol className={styles.list}>{output.proposals.map((proposal, index) => <li className={styles.resultItem} key={proposal.proposalKey}><h4>{c(`Sugerencia ${index + 1}`, `Suggestion ${index + 1}`)}</h4><p className={styles.suggestion}>{proposal.text}</p><p className={styles.hint}>{proposal.changeExplanation}</p><Evidence factIds={proposal.sourceFactIds} sources={sources} locale={locale}/><Warnings warnings={proposal.warnings} locale={locale}/></li>)}</ol>
        <p className={styles.hint}>{c('Estos textos aún no forman parte de tu CV. Revísalos antes de incluirlos.', 'These texts are not part of your resume yet. Review them before including them.')}</p>
      </>}
      {output.operation === 'ANSWER_DRAFT' && <>
        {sources.question && <div className={styles.section}><h4>{c('Pregunta', 'Question')}</h4><p className={styles.source}>{sources.question}</p></div>}
        {output.result.status === 'NEEDS_USER_INPUT' ? <Notice tone="info" role={null}><div className={styles.section}><h4>{c('Esta respuesta necesita tu criterio', 'This answer needs your input')}</h4><p>{output.result.explanation}</p><p className={styles.hint}>{c('No se ha generado una respuesta por ti.', 'No answer has been generated on your behalf.')}</p></div></Notice> : <>
          <h4>{c('Borrador para revisar', 'Draft to review')}</h4><p className={styles.suggestion}>{output.result.text}</p><Evidence factIds={output.result.evidence.map(item => item.factId)} sources={sources} locale={locale}/>
          <p className={styles.hint}>{c('La respuesta todavía no está guardada ni aprobada.', 'The answer has not been saved or approved yet.')}</p>
        </>}
      </>}
    </div>
    {onReview && artifact.state === 'PENDING_REVIEW' && <>
      {requiresConstraintReview && <label className={styles.check}><input type="checkbox" checked={acknowledgedConstraints === constraintReviewKey} onChange={event => setAcknowledgedConstraints(event.target.checked ? constraintReviewKey : null)}/><span>{c('Entiendo que esas condiciones no se usarán como filtros y las comprobaré en las ofertas.', 'I understand those conditions will not be used as filters and I will check them in the job postings.')}</span></label>}
      <div className={styles.actions}><Button type="button" disabled={requiresConstraintReview && acknowledgedConstraints !== constraintReviewKey} onClick={() => onReview(artifact)}>{output.operation === 'ANSWER_DRAFT' && output.result.status === 'NEEDS_USER_INPUT' ? c('Responder por mi cuenta', 'Write my own answer') : reviewLabels[output.operation]}</Button></div>
    </>}
  </section>;
}
