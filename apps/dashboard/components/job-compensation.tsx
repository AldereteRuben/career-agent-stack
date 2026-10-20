'use client';

import { formatJobCompensation, type JobCompensation } from '@career/domain';
import { useLocale } from '@/lib/i18n';

export type JobCompensationView = JobCompensation & { provider: string };

const sourceNames: Record<string, string> = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', remotive: 'Remotive', himalayas: 'Himalayas', arbeitnow: 'Arbeitnow' };

/** Pay exactly as the source states it, with the source named. Renders nothing when the source gave none. */
export function JobCompensationText({ compensation }: { compensation?: JobCompensationView | null }) {
  const { locale } = useLocale();
  if (!compensation) return null;
  const text = formatJobCompensation(compensation, locale);
  if (!text) return null;
  const source = sourceNames[compensation.provider] ?? compensation.provider;
  return <span className="job-compensation"><strong>{text}</strong> <small>{locale === 'es' ? `Según ${source}` : `As stated by ${source}`}</small></span>;
}
