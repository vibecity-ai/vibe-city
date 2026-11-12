/* The device kit (docs: Vibe City — Brand & UI Study, "Devices"): every tool the CEO opens is a physical device the
   company owns, a plastic shell with keys and a glowing screen. Presentation only; each device gets its data and
   actions from its own screen component.
   - Device: the shell (beige for the CEO's things, graphite for the floors' tools) with its name engraved on top.
   - Screen: amber CRT (the company), green CRT (markets), reflective LCD (the wallet), LED (code).
   - Key: a physical key; `hot` is the device's one main action (pink, lit). Renders a link when given `href`.
   - Grille: a speaker grille. */
import type { ReactNode } from 'react';

export function Device({ model, name, shell = 'graphite', led, className = '', children }: {
  model: string; name: string; shell?: 'beige' | 'graphite'; led?: 'green' | 'amber' | 'pink' | 'off'; className?: string; children: ReactNode;
}) {
  return (
    <div className={`dev ${shell} ${className}`}>
      <div className="dev-badge">
        {led && <i className={`dev-led ${led}`} aria-hidden="true" />}
        <b>{name}</b><span>{model}</span>
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

/** Seven-segment digits on an LCD, with the unlit "8"s ghosted behind them. */
export const Digits = ({ value, md }: { value: string; md?: boolean }) => <span className={`lcd-seg${md ? ' md' : ''}`} data-ghost={value.replace(/[0-9]/g, '8')}>{value}</span>;

export function Grille({ className = '' }: { className?: string }) {
  return <div className={`dev-grille ${className}`} aria-hidden="true" />;
}
