import type { NextConfig } from 'next';
import { securityHeaders } from '@career/domain/security-headers';

const apiBase = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
const nextConfig: NextConfig = {
  // Pages and assets; /api responses carry the same headers from the API itself (apps/api/src/server.ts).
  async headers() {
    return [{ source: '/((?!api/).*)', headers: [...securityHeaders] }];
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiBase}/api/:path*` }];
  },
  poweredByHeader: false,
  reactStrictMode: true,
  agentRules: false,
};

export default nextConfig;
