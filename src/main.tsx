import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

const root = createRoot(rootEl);

// Streaming playback (file.streamURL) needs WebTorrent's service worker
// active before we construct any MediaCache. Register first, then mount.
// Scope is the app's base path so streamURL responses (which live under
// <scope>/webtorrent/<infoHash>/...) fall inside the SW's control window.
async function registerStreamingWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register(
      `${import.meta.env.BASE_URL}sw.min.js`,
      { scope: import.meta.env.BASE_URL },
    );
    // ready resolves once a worker is active for this scope; until then
    // streamURL fetches would race the SW lifecycle and fail intermittently.
    await navigator.serviceWorker.ready;
    return reg;
  } catch (err) {
    console.warn('[jamboree] service worker registration failed', err);
    return null;
  }
}

void registerStreamingWorker().then((swRegistration) => {
  root.render(
    <StrictMode>
      <App swRegistration={swRegistration} />
    </StrictMode>,
  );
});
