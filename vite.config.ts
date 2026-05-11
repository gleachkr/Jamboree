import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// Mirror WebTorrent's prebuilt service worker into public/ so it's served
// at the site root as /Jamboree/sw.min.js. Streaming playback via
// `file.streamURL` requires this SW to intercept range requests against
// the chunk store (see src/core/media.ts). Re-copying on every Vite start
// keeps it in lockstep with whatever WebTorrent version `npm` installed.
const SW_SRC = path.resolve('./node_modules/webtorrent/dist/sw.min.js');
const SW_DST = path.resolve('./public/sw.min.js');
try {
  fs.mkdirSync(path.dirname(SW_DST), { recursive: true });
  fs.copyFileSync(SW_SRC, SW_DST);
} catch (err) {
  console.warn('[jamboree] failed to mirror webtorrent service worker:', err);
}

// HTTPS in dev is required for cross-machine LAN testing because Web Crypto
// (Trystero's room key derivation, etc.) is gated behind "secure context",
// which means https: OR localhost — plain http to a LAN IP doesn't qualify.
// basic-ssl ships a self-signed cert; browsers warn but accept after one
// click-through ("Advanced" → "Accept the risk").
//
// Side note: serving from a non-localhost origin also sidesteps a Firefox
// quirk where WebRTC default-address discovery fails on localhost-served
// pages with multi-interface hosts. Hit this hard during Stage 2 debugging.
//
// nodePolyfills is required by WebTorrent's transitive deps (bittorrent-*,
// torrent-discovery, streamx, etc.), which import 'events', 'path', 'crypto'
// directly. Vite's default browser stub returns an empty object for these,
// which crashes Rollup at build time when EventEmitter is named-imported.
export default defineConfig({
  base: '/Jamboree/',
  plugins: [
    react(),
    basicSsl(),
    nodePolyfills({
      // Only what WebTorrent's deps actually reach for. Buffer/process are
      // also pulled in transitively by bittorrent-protocol.
      include: ['events', 'path', 'crypto', 'stream', 'buffer', 'util'],
      globals: { Buffer: true, process: true },
    }),
  ],
  resolve: {
    alias: {
      // bittorrent-dht is excluded by WebTorrent's browser field. Vite's
      // default empty-stub breaks Rollup's destructured `import { Client }`.
      // Point at our own stub so build succeeds; runtime behaviour is the
      // same (DHT === undefined).
      'bittorrent-dht': fileURLToPath(
        new URL('./src/stubs/bittorrent-dht.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: true,
  },
  test: {
    environment: 'node',
    globals: true,
  },
});
