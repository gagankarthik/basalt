import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // loading data in an effect and showing a spinner is how every page here works
  { rules: { "react-hooks/set-state-in-effect": "off" } },
  // sign-in, sign-out and new connections load the whole page on purpose, to reset the client store
  { rules: { "@next/next/no-location-assign-relative-destination": "off" } },
  // attachments need the signed-in session, which the image optimizer doesn't send
  { files: ["src/components/BaseApp.tsx"], rules: { "@next/next/no-img-element": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
