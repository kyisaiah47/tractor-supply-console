import type { NextConfig } from "next";

// The Python API (backend/) owns every /api/* path. Next.js serves the UI and proxies the API,
// so browser code and curl both use /api/* on this origin. The destination is fixed at build time.
const API_URL = process.env.API_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  devIndicators: false,
  experimental: {
    // The planning assistant and the weekly job can run longer than the 30 s default.
    proxyTimeout: 120_000,
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
