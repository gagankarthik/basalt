import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.BASALT_DIST_DIR ?? ".next",
  // Customer data and keys must never be listed in a build, whatever the tracer infers. Checked by `npm run check:build`.
  outputFileTracingExcludes: { "/**/*": ["./data/**/*"] },
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
