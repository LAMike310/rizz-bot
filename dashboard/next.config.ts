import path from 'node:path';
import type {NextConfig} from 'next';

const securityHeaders = [
  {key: 'Cache-Control', value: 'no-store'},
  {key: 'X-Content-Type-Options', value: 'nosniff'},
  {key: 'X-Frame-Options', value: 'DENY'},
  {key: 'Referrer-Policy', value: 'no-referrer'},
  {key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()'},
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join('; ')
  }
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: path.join(process.cwd()),
  serverExternalPackages: ['better-sqlite3'],
  async headers() {
    return [{source: '/:path*', headers: securityHeaders}];
  }
};

export default nextConfig;
