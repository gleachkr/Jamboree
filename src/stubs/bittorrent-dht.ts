// Browser stub for bittorrent-dht. WebTorrent's `browser` field maps the
// real package to `false`, but Vite's empty stub doesn't satisfy
// `import { Client as DHT } from 'bittorrent-dht'` — Rollup errors on the
// destructure at build time. We provide a real ESM module exporting an
// undefined Client so consuming code (which already null-checks DHT) sees
// the same shape it would in a real "no DHT in browser" scenario.

export const Client = undefined;
export default {};
