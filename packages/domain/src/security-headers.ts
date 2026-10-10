/**
 * Browser security headers sent by both the dashboard and the API (issue #24). Defense in depth: the app already
 * listens on 127.0.0.1 only, checks Host and Origin, and uses an HttpOnly SameSite=Strict session cookie.
 * The Content-Security-Policy here only forbids framing; dashboard pages get the full policy below from proxy.ts.
 */
export const securityHeaders = [
  // Nothing may show the app inside a frame (clickjacking). X-Frame-Options covers browsers without frame-ancestors.
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  // Responses are only interpreted as their declared type.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Job sites and other external links get no referrer; same-origin navigation keeps it (the 404 page uses it).
  { key: 'Referrer-Policy', value: 'same-origin' },
  // Device features the app never uses.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
] as const;

/**
 * Content-Security-Policy for dashboard pages, with a fresh nonce per request. Next.js adds the nonce to its own
 * scripts, and 'strict-dynamic' lets those scripts load the app's chunks; nothing else may run.
 * Everything is same-origin: the API through the /api rewrite, the PDF.js worker and fonts from /pdf-assets.
 * Development additionally needs 'unsafe-eval' (React debugging) and inline <style> tags (CSS hot reloading).
 */
export function contentSecurityPolicy(nonce: string, { development = false }: { development?: boolean } = {}): string {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce)) throw new Error('A CSP nonce must be a random base64 value of at least 16 characters.');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    // In development Next.js injects <style> tags without the nonce; a nonce would make 'unsafe-inline' ignored.
    development ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    // React style={{…}} attributes (progress bars, layout tweaks). Attributes cannot run code.
    "style-src-attr 'unsafe-inline'",
    // Rendered PDF pages and the data export use data: and blob: URLs created by the app itself.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
