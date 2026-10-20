import { isValidDateOnly } from './application-dates.js';

export type ApplicationFollowUpLanguage = 'es' | 'en';

export type ApplicationFollowUpTemplateInput = {
  language: ApplicationFollowUpLanguage;
  company?: string | null;
  role?: string | null;
  applicationDate?: string | null;
  candidateName?: string | null;
};

export type ApplicationFollowUpTemplate = {
  language: ApplicationFollowUpLanguage;
  subject: string;
  body: string;
};

function clean(value: string | null | undefined) {
  return value?.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim() || '';
}

function formatDate(value: string, language: ApplicationFollowUpLanguage) {
  if (!isValidDateOnly(value)) throw new RangeError('INVALID_APPLICATION_DATE');
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat(language === 'es' ? 'es-ES' : 'en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(year!, month! - 1, day!, 12)));
}

/** Fixed, local-only copy template. It includes only application values explicitly supplied by the caller. */
export function buildApplicationFollowUpTemplate(input: ApplicationFollowUpTemplateInput): ApplicationFollowUpTemplate {
  const company = clean(input.company);
  const role = clean(input.role);
  const candidateName = clean(input.candidateName);
  const date = input.applicationDate ? formatDate(input.applicationDate, input.language) : '';
  const subjectDetails = [role, company ? (input.language === 'es' ? `en ${company}` : `at ${company}`) : ''].filter(Boolean).join(' ');

  if (input.language === 'es') {
    const context = [role ? `el puesto de ${role}` : '', company ? `en ${company}` : ''].filter(Boolean).join(' ');
    const application = context ? ` mi candidatura para ${context}` : ' mi candidatura';
    const dateSentence = date ? ` La presenté el ${date}.` : '';
    return {
      language: 'es',
      subject: `Seguimiento de mi candidatura${subjectDetails ? `: ${subjectDetails}` : ''}`,
      body: `Hola${candidateName ? ` ${candidateName}` : ''},\n\nTe escribo para consultar si hay alguna novedad sobre${application}.${dateSentence} Agradezco tu tiempo y quedo pendiente de cualquier actualización.\n\nUn saludo,`,
    };
  }

  const context = [role ? `the ${role} position` : '', company ? `at ${company}` : ''].filter(Boolean).join(' ');
  const application = context ? ` my application for ${context}` : ' my application';
  const dateSentence = date ? ` I submitted it on ${date}.` : '';
  return {
    language: 'en',
    subject: `Following up on my application${subjectDetails ? `: ${subjectDetails}` : ''}`,
    body: `Hello${candidateName ? ` ${candidateName}` : ''},\n\nI am writing to ask whether there are any updates on${application}.${dateSentence} I appreciate your time and look forward to hearing from you.\n\nBest regards,`,
  };
}
