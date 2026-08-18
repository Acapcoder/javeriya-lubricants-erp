/**
 * Bundles the server into one JavaScript module for the Vercel function.
 *
 * Vercel compiles api/index.ts to JavaScript but does not carry server/src
 * into the deployment, so the function cannot import the TypeScript sources at
 * runtime. It fails with "Cannot find module /var/task/server/src/env.ts", and
 * because that happens as the module loads, the platform reports only
 * FUNCTION_INVOCATION_FAILED. Bundling ahead of time removes the platform's
 * TypeScript resolution from the picture entirely.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['server/src/serverless.ts'],
  outfile: 'server/dist/serverless.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',

  /**
   * Kept out of the bundle:
   *   @electric-sql/pglite  the embedded development database. It ships a WASM
   *                         build that has no business in a deployment that
   *                         talks to Supabase, and the import is behind a
   *                         DATABASE_URL check that production never takes.
   *   pg-native             an optional native accelerator for pg, guarded by
   *                         a try/catch in the driver.
   */
  external: ['@electric-sql/pglite', 'pg-native'],

  /**
   * Some dependencies still call require() at runtime. In ESM output esbuild
   * replaces it with a shim that throws "Dynamic require of node:events is not
   * supported" unless a real `require` is in scope, so define one. The shim
   * checks for exactly this before giving up.
   */
  banner: {
    js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);",
  },

  logLevel: 'warning',
});
