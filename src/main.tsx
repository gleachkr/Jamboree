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
