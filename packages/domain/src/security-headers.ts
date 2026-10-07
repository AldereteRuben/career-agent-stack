/**
 * Browser security headers sent by both the dashboard and the API (issue #24). Defense in depth: the app already
 * listens on 127.0.0.1 only, checks Host and Origin, and uses an HttpOnly SameSite=Strict session cookie.
 * The Content-Security-Policy here only forbids framing; the full script/style policy is added separately.
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
