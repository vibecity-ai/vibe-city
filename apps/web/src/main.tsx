import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Town } from './town/main.tsx';

createRoot(document.getElementById('root')!).render(<StrictMode><Town /></StrictMode>);
