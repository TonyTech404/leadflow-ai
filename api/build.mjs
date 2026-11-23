// Bundles the Node server and the migration runner for the Docker image, so the runtime image
// needs no node_modules. The Cloudflare Worker is bundled by Wrangler instead.
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
};

await build({ ...shared, entryPoints: ['src/node.ts'], outfile: 'dist/server.mjs' });
await build({ ...shared, entryPoints: ['../scripts/migrate.mjs'], outfile: 'dist/migrate.mjs' });
