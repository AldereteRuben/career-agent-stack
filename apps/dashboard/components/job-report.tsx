'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobReport } from '@career/domain';
import { Button, Card, Notice, Tag } from '@/components/ui';
import { useLocale } from '@/lib/i18n';
import { api, errorMessage } from '@/lib/api';
import { copy, labelFor } from '@/lib/labels';
import styles from '@/app/jobs/jobs.module.css';

export const verdictTone = (verdict: string) => verdict === 'GOOD_OPTION' ? 'green' as const : verdict === 'PROBABLY_NOT_A_FIT' ? 'red' as const : 'amber' as const;

/**
 * The job evaluation report (#109): computed locally from the job and the person's confirmed facts, shown without
 * any action. Codex can only help through the separate "Understand this job" request, which previews what is shared.
 */
export function JobFitReport({ jobId, profileHref, assistantHref }: { jobId: string; profileHref: string; assistantHref: string | null }) {
  const { locale } = useLocale(); const c = copy(locale);
  const [report, setReport] = useState<JobReport | null>(null); const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading'); const [error, setError] = useState('');
  const request = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++request.current; setState('loading'); setError('');
    try {
      const result = await api<{ report: JobReport }>(`/jobs/${jobId}/report`);
      if (ticket === request.current) { setReport(result.report); setState('ready'); }
    } catch (err) { if (ticket === request.current) { setError(errorMessage(err)); setState('error'); } }
  }, [jobId]);
  useEffect(() => { void load(); return () => { request.current += 1; }; }, [load]);

  return <Card className={styles.report} aria-labelledby="job-report-heading" data-testid="job-report">
    <div className="panel-heading"><div><div className="eyebrow"><span className="eyebrow-mark"/> {c('INFORME DE EVALUACIÓN', 'EVALUATION REPORT')}</div><h2 id="job-report-heading" className="focus-heading" tabIndex={-1}>{c('¿Vale la pena postular?', 'Is it worth applying?')}</h2></div>{report && <Tag tone={verdictTone(report.verdict)}>{labelFor.reportVerdict(report.verdict, locale)}</Tag>}</div>
    {state === 'loading' && !report && <p role="status">{c('Preparando el informe…', 'Preparing the report…')}</p>}
    {state === 'error' && <Notice tone="warning" actions={<Button variant="quiet" onClick={() => void load()}>{c('Reintentar', 'Try again')}</Button>}>{c('No pudimos preparar el informe.', 'We could not prepare the report.')} {error}</Notice>}
    {report && <>
      <div className={styles.reportVerdict} data-verdict={report.verdict}>
        <p><strong>{c('Conclusión:', 'Conclusion:')}</strong> {labelFor.reportVerdict(report.verdict, locale)}</p>
        <ul>{report.reasons.map((reason) => <li key={reason}>{labelFor.reportReason(reason, locale)}</li>)}</ul>
        <small>{c(`Basado en ${report.basis.approvedFactCount} datos que confirmaste (revisión ${report.basis.profileRevision} de tu perfil) y en el texto de la oferta. No es la probabilidad de que te contraten.`, `Based on ${report.basis.approvedFactCount} details you confirmed (revision ${report.basis.profileRevision} of your profile) and the job text. It is not the probability of being hired.`)}</small>
      </div>
      <section aria-labelledby="job-report-supported" className={styles.reportSection}>
        <h3 id="job-report-supported">{c('1. Lo que pide la oferta y tu experiencia confirmada lo respalda', '1. What the job asks for, backed by your confirmed experience')}</h3>
        {report.supported.length ? <ul className={styles.reportList}>{report.supported.map((item) => <li key={item.skill}>
          <p><strong>{item.skill}</strong> <Tag tone="green">{labelFor.reportLevel(item.level, locale)}</Tag></p>
          {item.jobExcerpt && <blockquote className={styles.reportQuote}><span>{c('La oferta dice:', 'The job says:')}</span> {item.jobExcerpt}</blockquote>}
          <ul className={styles.reportFacts} aria-label={c(`Tus datos confirmados sobre ${item.skill}`, `Your confirmed details about ${item.skill}`)}>{item.facts.map((fact) => <li key={fact.factId}><span>{c('Tu dato confirmado:', 'Your confirmed detail:')}</span> {fact.text}</li>)}</ul>
        </li>)}</ul> : <p>{c('Ninguno todavía.', 'Nothing yet.')}</p>}
      </section>
      <section aria-labelledby="job-report-unconfirmed" className={styles.reportSection}>
        <h3 id="job-report-unconfirmed">{c('2. Lo que pide la oferta y aún no tienes confirmado', '2. What the job asks for that you have not confirmed yet')}</h3>
        {report.unconfirmed.length ? <><ul className={styles.reportList}>{report.unconfirmed.map((item) => <li key={item.skill}>
          <p><strong>{item.skill}</strong> <Tag tone="amber">{labelFor.reportLevel(item.level, locale)}</Tag></p>
          {item.jobExcerpt && <blockquote className={styles.reportQuote}><span>{c('La oferta dice:', 'The job says:')}</span> {item.jobExcerpt}</blockquote>}
        </li>)}</ul><p><small>{c('Si tienes esa experiencia, añádela en tu perfil y confírmala; nunca la suponemos.', 'If you have that experience, add it to your profile and confirm it; we never assume it.')} <Link href={profileHref}>{c('Ir a mi perfil', 'Go to my profile')}</Link></small></p></> : <p>{report.supported.length ? c('Tienes confirmado todo lo que reconocimos en la oferta.', 'You have confirmed everything we recognised in the job.') : c('No reconocimos requisitos concretos que comparar.', 'We did not recognise specific requirements to compare.')}</p>}
      </section>
      <section aria-labelledby="job-report-checks" className={styles.reportSection}>
        <h3 id="job-report-checks">{c('3. Revisa antes de postular', '3. Check before applying')}</h3>
        <dl className={styles.reportChecks}>{report.checks.map((check) => <div key={check.kind}><dt>{labelFor.reportCheck(check.kind, locale)}</dt><dd><strong>{labelFor.reportCheckStatus(check.status, locale)}</strong>{check.value && <span>{check.value}</span>}</dd></div>)}</dl>
      </section>
      <section aria-labelledby="job-report-unknowns" className={styles.reportSection}>
        <h3 id="job-report-unknowns">{c('4. Lo que no sabemos', '4. What we do not know')}</h3>
        {report.unknowns.length ? <ul>{report.unknowns.map((code) => <li key={code}>{labelFor.reportUnknown(code, locale)}</li>)}</ul> : <p>{c('Nada destacable.', 'Nothing notable.')}</p>}
      </section>
      <p className={styles.reportFoot}><small>{c('Este informe se calcula en tu equipo con reglas fijas y no usa ninguna cuenta de IA. Solo compara las habilidades que sabemos reconocer.', 'This report is calculated on your computer with fixed rules and uses no AI account. It only compares the skills we know how to recognise.')}</small>{assistantHref && <> <a href={assistantHref}>{c('Pedir a Codex un resumen de la oferta', 'Ask Codex to summarize the job')}</a> <small>{c('(antes de enviar nada verás qué se comparte)', '(you will see what is shared before anything is sent)')}</small></>}</p>
    </>}
  </Card>;
}
