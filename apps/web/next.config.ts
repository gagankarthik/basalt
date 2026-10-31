import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.BASALT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        // Blocks being framed by another site and injected <base> or plugins. Scripts aren't limited yet, because the framework's inline scripts would need nonces first
        { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'" },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
      ],
    }];
  },
  // Customer data and keys must never be listed in a build, whatever the tracer infers. Checked by `npm run check:build`.
  outputFileTracingExcludes: { "/**/*": ["./data/**/*", "../../data/**/*"] },
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings", "pg", "mysql2", "@aws-sdk/client-dynamodb", "@aws-sdk/client-athena", "@google-cloud/firestore", "@google-cloud/spanner", "@grpc/grpc-js", "@azure/cosmos", "mssql"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
