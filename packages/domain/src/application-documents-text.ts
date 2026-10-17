import type { ApplicationDocumentSentence } from './application-documents-builder.js';

/** Renders only approved claim text in order; it does not rewrite, normalize, or translate wording. */
export function renderApplicationDocumentText(claims: ApplicationDocumentSentence[]) {
  return claims.map((claim) => claim.text).join('\n');
}
