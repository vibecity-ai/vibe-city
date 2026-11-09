/* The device kit (docs: Vibe City — Brand & UI Study, "Devices"): every tool the CEO opens is a physical device the
   company owns, a plastic shell with keys and a glowing screen. Presentation only; each device gets its data and
   actions from its own screen component.
   - Device: the shell (beige for the CEO's things, graphite for the floors' tools) with the maker's badge.
   - Screen: amber CRT (the company), green CRT (markets), reflective LCD (the wallet), LED (code).
   - Key: a physical key; `hot` is the device's one main action (pink, lit). Renders a link when given `href`.
   - Gauge: a needle meter. Grille: a speaker grille. */
import type { ReactNode } from 'react';

export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg className="dev-mark" width={size * 1.375} height={size} viewBox="0 0 22 16" aria-hidden="true">
      <rect x="0" y="8" width="3" height="8" fill="#2EB8C0" /><rect x="4.5" y="5" width="3" height="11" fill="#2EB8C0" />
      <rect x="9" y="0" width="3" height="16" fill="#E0368F" /><rect x="13.5" y="4" width="3" height="12" fill="#2EB8C0" />
      <rect x="18" y="7" width="3" height="9" fill="#4FBF7A" />
    </svg>
  );
}

export function Device({ model, name, shell = 'graphite', led, className = '', children }: {
  model: string; name: string; shell?: 'beige' | 'graphite'; led?: 'green' | 'amber' | 'pink' | 'off'; className?: string; children: ReactNode;
}) {
  return (
    <div className={`dev ${shell} ${className}`}>
      <div className="dev-badge">
        {led && <i className={`dev-led ${led}`} aria-hidden="true" />}
        <Mark /><b>Vibe City</b><span>{model} · {name}</span>
      </div>
      {children}
    </div>
  );
}

export function Screen({ kind, className = '', children, label }: { kind: 'amber' | 'green' | 'lcd' | 'led'; className?: string; children: ReactNode; label?: string }) {
  return <div className={`dev-screen ${kind} ${className}`} role={label ? 'group' : undefined} aria-label={label}>{children}</div>;
}

type KeyProps = { children: ReactNode; hot?: boolean; lit?: boolean; disabled?: boolean; onClick?: () => void; href?: string; title?: string; type?: 'button' | 'submit'; pressed?: boolean };
export function Key({ children, hot, lit, disabled, onClick, href, title, type = 'button', pressed }: KeyProps) {
  const cls = `dev-key${hot ? ' hot' : ''}${lit ? ' lit' : ''}`;
  if (href && !disabled) return <a className={cls} href={href} target="_blank" rel="noreferrer" title={title}>{children}</a>;
  return <button className={cls} type={type} disabled={disabled} onClick={onClick} title={title} aria-pressed={pressed}>{children}</button>;
}

export function Grille({ className = '' }: { className?: string }) {
  return <div className={`dev-grille ${className}`} aria-hidden="true" />;
}

/** A needle meter from 0 to `max`; `value` null parks the needle at zero and dims it. */
export function Gauge({ value, max, ticks, label }: { value: number | null; max: number; ticks: number[]; label: string }) {
  const cx = 115, cy = 112, r = 95;
  const at = (v: number) => { const a = Math.PI * (1 - Math.min(Math.max(v, 0), max) / max); return [cx + r * Math.cos(a), cy - r * Math.sin(a)] as const; };
  const tip = (v: number) => { const a = Math.PI * (1 - Math.min(Math.max(v, 0), max) / max); return [cx + 80 * Math.cos(a), cy - 80 * Math.sin(a)] as const; };
  const [nx, ny] = tip(value ?? 0);
  const [rx, ry] = at(max * 0.7);
  return (
    <svg className={`dev-gauge${value === null ? ' idle' : ''}`} viewBox="0 0 230 140" role="img" aria-label={`${label}: ${value ?? 'unknown'}`}>
      <path d={`M${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx + r} ${cy}`} className="arc" />
      <path d={`M${rx} ${ry} A${r} ${r} 0 0 1 ${cx + r} ${cy}`} className="arc-hi" />
      {ticks.map((t) => { const [x1, y1] = at(t); const [x2, y2] = tip(t * 1); const k = 0.89; return (
        <g key={t}>
          <line x1={x1} y1={y1} x2={cx + (x1 - cx) * k} y2={cy + (y1 - cy) * k} className="tick" />
          <text x={cx + (x2 - cx) * 0.86} y={cy + (y2 - cy) * 0.86 + 4} className="num">{t}</text>
        </g>
      ); })}
      <line x1={cx} y1={cy} x2={nx} y2={ny} className="needle" />
      <circle cx={cx} cy={cy} r="6" className="hub" />
      <text x={cx} y="136" className="lbl">{label}</text>
    </svg>
  );
}
