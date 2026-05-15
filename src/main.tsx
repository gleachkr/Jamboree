import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

const root = createRoot(rootEl);

// Do not wrap the app in React StrictMode while network transports are created
// from effects. In dev, StrictMode intentionally mounts, cleans up, and mounts
// again; Trystero's module-level relay/offer-pool state does not seem to like
// that rapid join → leave → join cycle. It can make discovery look broken even
// though the room code is otherwise fine.
root.render(<App />);

// Register the PWA service worker after first paint, production only — Vite
// dev's HMR fetches don't mix well with a cache-first SW. The SW scope is
// implicitly the directory it lives in (e.g. /Jamboree/), so deep links to
// /Jamboree/r/<id> are still covered.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((err) => console.warn('[jam/sw] registration failed', err));
  });
}
