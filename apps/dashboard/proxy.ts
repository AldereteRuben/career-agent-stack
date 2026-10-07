import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy } from '@career/domain/security-headers';

/**
 * A fresh CSP nonce for every page (issue #24). Next.js reads the nonce from the request's Content-Security-Policy
 * header and adds it to its own scripts; every page is already rendered per request (the root layout reads headers).
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const policy = contentSecurityPolicy(nonce, { development: process.env.NODE_ENV === 'development' });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [{
    // Pages only: the API sets its own headers, and static files, PDF.js assets and prefetches need no policy.
    source: '/((?!api/|_next/static|_next/image|pdf-assets/|favicon.ico).*)',
    missing: [
      { type: 'header', key: 'next-router-prefetch' },
      { type: 'header', key: 'purpose', value: 'prefetch' },
    ],
  }],
};
