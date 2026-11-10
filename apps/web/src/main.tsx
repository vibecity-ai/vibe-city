import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Town } from './town/main.tsx';
import { InvestPage } from './invest/InvestPage.tsx';

createRoot(document.getElementById('root')!).render(<StrictMode>{location.pathname === '/invest' ? <InvestPage /> : <Town />}</StrictMode>);
