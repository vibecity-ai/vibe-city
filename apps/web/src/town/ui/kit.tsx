import type { ReactNode } from 'react';
import type { QuestStatus } from '@vibe-city/shared';
import type { AgentStatus, DeptState } from '../data/types';

/* Status: shape + colour + word, never colour alone (design system rule). */
export type StatusKey = AgentStatus | 'blocked' | 'todo' | 'connected';
const S: Record<StatusKey, { c: string; label: string; bg: string }> = {
  running: { c: '#2EE6F0', label: 'Running', bg: 'rgba(46,230,240,0.12)' },
  idle: { c: '#B3ACDD', label: 'Idle', bg: 'rgba(179,172,221,0.12)' },
  completed: { c: '#7CF5B4', label: 'Completed', bg: 'rgba(124,245,180,0.12)' },
  failed: { c: '#FF5C7A', label: 'Failed', bg: 'rgba(255,92,122,0.14)' },
  disconnected: { c: '#9A94B8', label: 'Disconnected', bg: 'transparent' },
  awaiting: { c: '#FFB547', label: 'Awaiting config', bg: 'rgba(255,181,71,0.12)' },
  blocked: { c: '#FF9A55', label: 'Blocked', bg: 'rgba(255,138,61,0.14)' },
  todo: { c: '#B3ACDD', label: 'To do', bg: 'rgba(179,172,221,0.12)' },
  connected: { c: '#7CF5B4', label: 'Connected', bg: 'rgba(124,245,180,0.12)' },
};
export const statusColor = (k: StatusKey) => S[k].c;
export const statusLabel = (k: StatusKey) => S[k].label;

export function Glyph({ k, size = 10 }: { k: StatusKey; size?: number }) {
  const c = S[k].c;
  const path: Record<StatusKey, ReactNode> = {
    running: <path d="M5 0L10 5L5 10L0 5Z" fill={c} />,
    idle: <path d="M0 3.5H10V6.5H0Z" fill={c} />,
    completed: <path d="M1 5.2L4 8.2L9.2 1.8" stroke={c} strokeWidth="2.4" fill="none" strokeLinecap="square" />,
    connected: <path d="M1 5.2L4 8.2L9.2 1.8" stroke={c} strokeWidth="2.4" fill="none" strokeLinecap="square" />,
    failed: <path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" stroke={c} strokeWidth="2.4" fill="none" strokeLinecap="square" />,
    disconnected: <path d="M1.5 1.5H8.5V8.5H1.5Z" stroke={c} strokeWidth="1.6" fill="none" />,
    awaiting: <path d="M5 0.6L9.6 9.4H0.4Z" fill={c} />,
    blocked: <path d="M2 1H4V9H2ZM6 1H8V9H6Z" fill={c} />,
    todo: <path d="M5 1A4 4 0 1 1 4.99 1Z" stroke={c} strokeWidth="1.6" fill="none" />,
  };
  return <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true" style={{ flex: 'none', overflow: 'visible' }}>{path[k]}</svg>;
}

export function Chip({ k, label, small }: { k: StatusKey; label?: string; small?: boolean }) {
  return <span className={`chip${small ? ' sm' : ''}${k === 'disconnected' ? ' dashed' : ''}`} style={{ color: S[k].c, background: S[k].bg }}><Glyph k={k} />{label ?? S[k].label}</span>;
}

/** Elevator-key floor number: PH, F1..F9. Tone follows what the floor is. */
export function FloorKey({ n, tone = 'cyan' }: { n: string; tone?: 'cyan' | 'gold' | 'amber' | 'dim' }) {
  return <span className={`fkey ${tone}`}>{n}</span>;
}
/** Where you are: a floor key plus a plain description, used at the top of every pane. */
export function Where({ n, tone, children }: { n: string; tone?: 'cyan' | 'gold' | 'amber' | 'dim'; children: ReactNode }) {
  return <div className="where"><FloorKey n={n} tone={tone} /><span>{children}</span></div>;
}

export const deptStatus = (s: DeptState): { k: StatusKey; label: string } => ({
  active: { k: 'running' as StatusKey, label: 'Active' }, idle: { k: 'idle' as StatusKey, label: 'Idle' },
  attention: { k: 'failed' as StatusKey, label: 'Needs attention' }, offline: { k: 'disconnected' as StatusKey, label: 'Disconnected' },
  unconfigured: { k: 'awaiting' as StatusKey, label: 'Unconfigured' },
})[s];
export const questStatus = (s: QuestStatus): StatusKey => ({
  queued: 'todo', planning: 'running', running: 'running', cancelling: 'blocked', awaiting_input: 'blocked', in_review: 'blocked',
  failed: 'failed', completed: 'completed', cancelled: 'disconnected',
} as const)[s];

const P: Record<string, ReactNode> = {
  plus: <path d="M12 4v16M4 12h16" />, x: <path d="M6 6l12 12M18 6L6 18" />, chev: <path d="M9 6l6 6-6 6" />, back: <path d="M15 6l-6 6 6 6" />,
  sliders: <><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></>,
  sparkle: <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z" />, plug: <path d="M9 3v5M15 3v5M7 8h10v4a5 5 0 01-10 0zM12 17v4" />,
  chip: <><rect x="7" y="7" width="10" height="10" rx="1" /><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" /></>,
  folder: <path d="M3 6h7l2 2h9v11H3z" />, shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />, gauge: <><path d="M4 16a8 8 0 1116 0" /><path d="M12 16l4-5" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>, download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />, ext: <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
  refresh: <path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6" />, lock: <><rect x="5" y="11" width="14" height="9" rx="1" /><path d="M8 11V8a4 4 0 018 0v3" /></>,
  more: <><circle cx="6" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="18" cy="12" r="1.2" /></>, fit: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  minus: <path d="M5 12h14" />, building: <path d="M5 21V5l7-3 7 3v16M9 9h1M14 9h1M9 13h1M14 13h1M10 21v-4h4v4" />,
};
export function Icon({ n, size = 16, sw = 2 }: { n: keyof typeof P | string; size?: number; sw?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{P[n]}</svg>;
}

/* Pixel portrait matching the in-world sprites. */
export function Portrait({ shirt, chief, size = 40, ghost }: { shirt: string; chief?: boolean; size?: number; ghost?: boolean }) {
  if (ghost) return <svg width={size} height={size} viewBox="0 0 16 16" className="portrait"><rect x="5" y="2" width="6" height="5" fill="none" stroke="#FFB547" strokeDasharray="1 1" /><rect x="3" y="8" width="10" height="7" fill="none" stroke="#FFB547" strokeDasharray="1 1" /></svg>;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="portrait" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="5" y="1" width="6" height="2" fill="#2B1D14" /><rect x="5" y="3" width="6" height="4" fill="#F1C9A3" /><rect x="5" y="3" width="1" height="2" fill="#2B1D14" /><rect x="10" y="3" width="1" height="2" fill="#2B1D14" />
      <rect x="6" y="5" width="1" height="1" fill="#1B1428" /><rect x="9" y="5" width="1" height="1" fill="#1B1428" />
      <rect x="3" y="8" width="10" height="8" fill={chief ? '#F4EEFF' : shirt} />{chief && <rect x="7" y="8" width="2" height="7" fill="#FF3EA5" />}
    </svg>
  );
}

export function Btn({ kind = 'tertiary', children, onClick, disabled, title, type }: { kind?: 'primary' | 'secondary' | 'tertiary' | 'destructive' | 'warn'; children: ReactNode; onClick?: () => void; disabled?: boolean; title?: string; type?: 'button' | 'submit' }) {
  return <button type={type ?? 'button'} className={`btn ${kind}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>;
}
