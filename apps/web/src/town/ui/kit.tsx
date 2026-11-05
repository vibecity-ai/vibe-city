import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
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
  minus: <path d="M5 12h14" />, search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>, bell: <path d="M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20a2 2 0 004 0" />, phone: <path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a1 1 0 01-1 1A16 16 0 014 5a1 1 0 011-1z" />, building: <path d="M5 21V5l7-3 7 3v16M9 9h1M14 9h1M9 13h1M14 13h1M10 21v-4h4v4" />,
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

export function Btn({ kind = 'tertiary', children, onClick, disabled, title, type, busy }: { kind?: 'primary' | 'secondary' | 'tertiary' | 'destructive' | 'warn'; children: ReactNode; onClick?: () => void; disabled?: boolean; title?: string; type?: 'button' | 'submit'; busy?: boolean }) {
  return <button type={type ?? 'button'} className={`btn ${kind}`} onClick={onClick} disabled={disabled} title={title} aria-busy={busy || undefined}>{busy && <span className="pulse-dot" aria-hidden="true" />}{children}</button>;
}

/* ---- accessibility helpers ---- */

/** Tablist with arrow-key/Home/End navigation and roving tabindex. */
export function Tabs<T extends string>({ value, options, onChange, label, idBase }: { value: T; options: readonly { key: T; label: ReactNode }[]; onChange: (v: T) => void; label: string; idBase?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    const i = options.findIndex((o) => o.key === value);
    const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : null;
    if (n === null) return;
    e.preventDefault();
    const next = options[(n + options.length) % options.length]!;
    onChange(next.key);
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`[data-k="${next.key}"]`)?.focus());
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={ref} onKeyDown={onKey}>
      {options.map((o) => (
        <button key={o.key} type="button" role="tab" data-k={o.key} id={idBase ? `${idBase}-tab-${o.key}` : undefined} aria-controls={idBase ? `${idBase}-panel` : undefined}
          aria-selected={value === o.key} tabIndex={value === o.key ? 0 : -1} className={value === o.key ? 'on' : ''} onClick={() => onChange(o.key)}>{o.label}</button>
      ))}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal dialog behaviour: focus the first field, trap Tab inside, close on Escape, restore focus on close. */
export function useDialog(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open || !ref.current) return;
    const el = ref.current;
    const prev = document.activeElement as HTMLElement | null;
    (el.querySelector<HTMLElement>('[autofocus], input, textarea') ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); return; } // the stage's Escape (leave floor) must not also fire
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!f.length) return;
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (prev?.isConnected) prev.focus(); };
  }, [open, ref]);
}

/** Label + control + hint + error, wired with aria-describedby / aria-invalid. */
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (p: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode }) {
  const id = useId();
  const desc = [hint ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label className="lbl" htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': desc, 'aria-invalid': error ? true : undefined })}
      {hint && <small id={`${id}-h`} className="muted">{hint}</small>}
      {error && <small id={`${id}-e`} className="field-err" role="alert"><Glyph k="failed" />{error}</small>}
    </div>
  );
}

/** Definition list of label/value rows (inspectors). */
export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return <dl className="kv">{rows.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

/* ---------- PixelSelect: the game's dropdown (native <select> menus render as OS widgets, white on Windows). ----------
   A button that opens a framed listbox in a portal: below the trigger (above when there is no room), a bottom sheet
   on phones. Keyboard: arrows/Home/End move, Enter/Space choose, Esc closes, typing jumps to a matching option. */
export interface SelectOption { value: string; label: string; group?: string; disabled?: boolean; note?: string }

export function PixelSelect({ id, value, options, onChange, disabled, placeholder = 'Choose…', mono, ...aria }: {
  id?: string; value: string; options: readonly SelectOption[]; onChange: (v: string) => void; disabled?: boolean;
  placeholder?: string; mono?: boolean; 'aria-describedby'?: string; 'aria-invalid'?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxH: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ s: '', t: 0 });
  const lid = useId();
  const cur = options.find((o) => o.value === value);
  const sheet = typeof window !== 'undefined' && window.innerWidth <= 760;

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect(); if (!r) return;
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const up = below < 220 && above > below;
    setPos({ left: r.left, width: r.width, ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }), maxH: Math.min(360, up ? above : below) });
  }, []);
  const show = () => { if (disabled) return; place(); setActive(Math.max(0, options.findIndex((o) => o.value === value))); setOpen(true); };
  const hide = (focus = true) => { setOpen(false); if (focus) btn.current?.focus(); };
  const choose = (i: number) => { const o = options[i]; if (!o || o.disabled) return; onChange(o.value); hide(); };
  const step = (from: number, d: number) => {
    for (let i = from + d, n = 0; n < options.length; i += d, n++) {
      const j = (i + options.length) % options.length; if (!options[j]!.disabled) return j;
    }
    return from;
  };

  useLayoutEffect(() => {
    if (!open) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`); el?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);
  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const away = (e: PointerEvent) => { if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) hide(false); };
    const move = () => { if (!sheet) place(); };
    window.addEventListener('pointerdown', away, true); window.addEventListener('resize', move); window.addEventListener('scroll', move, true);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('resize', move); window.removeEventListener('scroll', move, true); };
  }, [open, sheet, place]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => step(a, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => step(a, -1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(step(-1, 1)); }
    else if (e.key === 'End') { e.preventDefault(); setActive(step(options.length, -1)); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
    else if (e.key === 'Tab') hide(false);
    else if (e.key.length === 1) {
      const now = performance.now(); typed.current = { s: (now - typed.current.t > 700 ? '' : typed.current.s) + e.key.toLowerCase(), t: now };
      const i = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.s)); if (i >= 0) setActive(i);
    }
  };

  let lastGroup: string | undefined;
  const menu = open && pos && createPortal(
    <>
      {sheet && <div className="psel-scrim" onPointerDown={() => hide(false)} />}
      <ul ref={list} id={lid} role="listbox" tabIndex={-1} aria-activedescendant={active >= 0 ? `${lid}-${active}` : undefined}
        className={`psel-list${sheet ? ' sheet' : ''}${mono ? ' mono' : ''}`} onKeyDown={onKey}
        style={sheet ? undefined : { left: pos.left, width: Math.max(pos.width, 220), top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}>
        {options.map((o, i) => {
          const head = o.group && o.group !== lastGroup ? <li key={`g-${o.group}`} role="presentation" className="psel-group">{o.group}</li> : null;
          lastGroup = o.group;
          return [head,
            <li key={o.value || '_empty'} id={`${lid}-${i}`} data-i={i} role="option" aria-selected={o.value === value} aria-disabled={o.disabled || undefined}
              className={`psel-opt${i === active ? ' on' : ''}${o.value === value ? ' sel' : ''}`}
              onPointerEnter={() => !o.disabled && setActive(i)} onClick={() => choose(i)}>
              <span>{o.label}</span>{o.note && <small>{o.note}</small>}
            </li>];
        })}
      </ul>
    </>, document.body);

  return (
    <>
      <button ref={btn} type="button" id={id} className={`input psel${mono ? ' mono' : ''}${open ? ' open' : ''}`} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? lid : undefined} {...aria}
        onClick={() => (open ? hide() : show())} onKeyDown={onKey}>
        <span className={cur ? '' : 'muted'}>{cur?.label ?? placeholder}</span>
        <svg width="12" height="8" viewBox="0 0 6 4" aria-hidden="true" shapeRendering="crispEdges"><path d="M0 0h6L3 4z" fill="currentColor" /></svg>
      </button>
      {menu}
    </>
  );
}
