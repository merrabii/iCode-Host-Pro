/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Proxy /api/* to the NestJS API so the browser stays same-origin on :3000
  // (keeps the httpOnly refresh cookie working — ADR-015). API_UPSTREAM can be
  // overridden in env for a deployed API.
  async rewrites() {
    const api = process.env.API_UPSTREAM ?? 'http://localhost:3001';
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;