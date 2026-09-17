import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

import { withGatewayCsp } from './src/web/arweave-gateway.js';

/**
 * Let the browser actually REACH the store gateway the build reads from.
 *
 * `index.html` ships a CSP whose `connect-src` names only the three public
 * Arweave gateways, so a `VITE_ARWEAVE_GATEWAY` fetch would be blocked before
 * it left the page (rig#177). This stamps that gateway's origin into the
 * policy in dev and in build, derived from the same env var that addresses
 * the fetch — the host list itself is never duplicated here.
 */
function gatewayCspPlugin(): Plugin {
  let gateway: string | undefined;
  return {
    name: 'rig-web:gateway-csp',
    configResolved(config) {
      gateway =
        (config.env['VITE_ARWEAVE_GATEWAY'] as string | undefined) ??
        process.env['VITE_ARWEAVE_GATEWAY'];
    },
    transformIndexHtml(html) {
      return withGatewayCsp(html, gateway);
    },
  };
}

export default defineConfig({
  base: './',
  root: resolve(import.meta.dirname, 'src/web'),
  plugins: [react(), tailwindcss(), gatewayCspPlugin()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src/web'),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/web/index.html'),
      output: {
        // Keep every chunk's GZIPPED size under ArDrive Turbo's 105 KiB
        // free-tier per-file cap: the Arweave deployment uploads each output
        // gzipped (Content-Encoding tag), so the constraint is per chunk.
        // node_modules split per top-level package (`v-<pkg>`) — no single
        // dependency gzips anywhere near the cap once separated — leaving
        // only app code in the entry chunk (README "Deploying").
        manualChunks(id: string) {
          const m = id.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
          if (!m) return undefined; // app code → entry/dynamic chunks
          const pkg = (m[1] as string).replace(/^@/, '').replace('/', '-');
          // shiki keeps its own per-language dynamic chunks.
          if (pkg.startsWith('shiki')) return undefined;
          return `v-${pkg}`;
        },
      },
    },
  },
});
