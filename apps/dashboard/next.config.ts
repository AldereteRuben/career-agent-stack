import type { NextConfig } from 'next';

const apiBase = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiBase}/api/:path*` }];
  },
  poweredByHeader: false,
  reactStrictMode: true,
  agentRules: false,
};

export default nextConfig;
