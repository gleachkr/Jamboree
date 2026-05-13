import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS in dev is required for cross-machine LAN testing because Web Crypto
// (Trystero's room key derivation, etc.) is gated behind "secure context",
// which means https: OR localhost — plain http to a LAN IP doesn't qualify.
// basic-ssl ships a self-signed cert; browsers warn but accept after one
// click-through ("Advanced" → "Accept the risk").
//
// Side note: serving from a non-localhost origin also sidesteps a Firefox
// quirk where WebRTC default-address discovery fails on localhost-served
// pages with multi-interface hosts. Hit this hard during Stage 2 debugging.
export default defineConfig({
  base: '/Jamboree/',
  plugins: [react(), basicSsl()],
  server: {
    host: true,
  },
  test: {
    environment: 'node',
    globals: true,
  },
});
