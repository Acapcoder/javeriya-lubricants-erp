/**
 * The single entry point that gets bundled for serverless deployment.
 *
 * Vercel compiles api/index.ts to JavaScript but does not carry the server's
 * TypeScript sources with it, so a function importing `../server/src/app.ts`
 * fails at runtime with "Cannot find module .../server/src/env.ts". Rather
 * than depend on the platform tracing `.ts` imports, `npm run build:api`
 * bundles this file, and its whole import graph, into one JavaScript module
 * that the function loads.
 *
 * One entry rather than two, because `buildApp` and `assertProductionSafety`
 * must come from the same module instance: bundling them separately would give
 * each its own copy of the env module and its own connection pool.
 */
export { buildApp } from './app.ts';
export { assertProductionSafety } from './env.ts';
