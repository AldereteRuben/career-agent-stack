import PostalMime from 'postal-mime';
import type { RecruitmentStage } from '@career/domain';

export const MAX_EMAIL_BYTES = 1_000_000;
const stageRules: Array<{ stage: RecruitmentStage; expressions: RegExp[] }> = [
  { stage: 'REJECTED', expressions: [/\b(?:not\s+(?:be\s+)?moving forward|decided not to proceed|regret to inform|not selected|unsuccessful|no podemos continuar|no seguiremos|no has sido seleccionado|no hemos seleccionado)\b/i, /\b(?:we have decided|we decided) to offer (?:the position|the role) to another candidate\b/i] },
  { stage: 'OFFER', expressions: [/\b(?:pleased|excited|delighted) to offer\b/i, /\b(?:we would like|we'd like|i would like|i'd like) to offer\b/i, /\b(?:offer you the (?:position|role)|job offer|offer letter|employment contract|contrato de trabajo|te ofrecemos el puesto|le ofrecemos el puesto)\b/i] },
  { stage: 'INTERVIEW', expressions: [/\b(?:interview|interviewing|schedule an? (?:interview|call)|invite you to (?:an? )?interview|entrevista|agendar una llamada)\b/i] },
  { stage: 'ASSESSMENT', expressions: [/\b(?:assessment|coding challenge|technical test|take[- ]home|prueba técnica|evaluación)\b/i] },
  { stage: 'RECRUITER_CONTACT', expressions: [/\b(?:recruiter|recruitment team|phone screen|screening call|recruiting team|equipo de selección|llamada inicial)\b/i] },
];

export async function parseEml(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_EMAIL_BYTES) throw new Error('EMAIL_FILE_TOO_LARGE');
  const parsed = await new PostalMime({ attachmentEncoding: 'base64', maxNestingDepth: 32, maxRfc822NestingDepth: 2, maxHeadersSize: 64_000, maxPartCount: 100 }).parse(bytes);
  let messageDate: string | null = null;
  if (parsed.date) { const date = new Date(parsed.date); if (Number.isFinite(date.getTime())) messageDate = date.toISOString(); }
  return { text: parsed.text ?? '', messageId: parsed.messageId?.trim() || undefined, messageDate };
}

export function findStage(text: string): { stage: RecruitmentStage | null; excerpt: string } {
  for (const rule of stageRules) {
    for (const expression of rule.expressions) {
      const match = expression.exec(text);
      if (!match || match.index === undefined) continue;
      const start = Math.max(0, match.index - 100);
      const end = Math.min(text.length, match.index + match[0].length + 140);
      return { stage: rule.stage, excerpt: text.slice(start, end).replace(/\s+/g, ' ').trim() };
    }
  }
  return { stage: null, excerpt: text.slice(0, 240).replace(/\s+/g, ' ').trim() };
}
