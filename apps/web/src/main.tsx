import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// The city is the main app. The original quest board stays reachable at #board (a full reload, so the two stylesheets never mix).
const board = location.hash === '#board';
window.addEventListener('hashchange', () => location.reload());

const root = createRoot(document.getElementById('root')!);
if (board) {
  void Promise.all([import('./board/App.tsx'), import('./board/styles.css')]).then(([m]) => root.render(<StrictMode><m.App /></StrictMode>));
} else {
  void import('./town/main.tsx').then((m) => root.render(<StrictMode><m.Town /></StrictMode>));
}
