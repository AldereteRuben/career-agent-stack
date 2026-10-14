import type { NextConfig } from 'next';
import { securityHeaders } from '@career/domain/security-headers';

const apiBase = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
const nextConfig: NextConfig = {
  // Pages and assets; /api responses carry the same headers from the API itself (apps/api/src/server.ts).
  // Pages get their Content-Security-Policy, with a per-request nonce, from proxy.ts instead.
  async headers() {
    return [{ source: '/((?!api/).*)', headers: securityHeaders.filter((header) => header.key !== 'Content-Security-Policy') }];
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiBase}/api/:path*` }];
  },
  poweredByHeader: false,
  reactStrictMode: true,
  agentRules: false,
};

export default nextConfig;
