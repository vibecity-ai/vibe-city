/* What a new floor's agents may use, picked like gear (the hire window's Capabilities step):
   - ToolPicker: toolsets as tiles in plain words; risky ones (they reach outside or run code) are marked.
   - SkillPicker: skills as cards you click to equip, by school, with the template's own skills first. */
import { useMemo, useState, type JSX, type ReactNode } from 'react';
import type { Toolset } from '@vibe-city/shared';
import { Icon } from './kit';
import { SkillCard, SkillGlyph } from './Skills';
import { BASE, TOOL_INFO, isRequiredToolset } from '../data/floor';
import { SCHOOLS, bySchool, skillMeta, type School } from '../data/skills';

export interface ToolChoice { name: string; enabled: boolean; manageable: boolean }

/** One line-icon per toolset (24px grid, drawn with the stroke of the kit's icons). */
const TOOL_ICON: Record<string, JSX.Element> = {
  web: <><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16" /></>,
  browser: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18M6 7h.01M8.5 7h.01" /></>,
  terminal: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 10l3 2-3 2M12 15h5" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>,
  code_execution: <><path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12" /></>,
  vision: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  image_gen: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 16l5-5 4 4 3-3 6 6" /><circle cx="16" cy="9" r="1.5" /></>,
  video: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3" /></>,
  video_gen: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3M9.5 9v6M6.5 12h6" /></>,
  x_search: <><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5M8 8l5 5M13 8l-5 5" /></>,
  tts: <><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" /></>,
  stt: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></>,
  memory: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M10 10h4v4h-4z" /></>,
  session_search: <><path d="M4 5h16v11H9l-5 4z" /><path d="M9 10h6" /></>,
  skills: <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z" />,
  todo: <><path d="M4 6l2 2 3-3M4 13l2 2 3-3M12 7h8M12 14h8M12 20h8" /></>,
  kanban: <><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="10" rx="1" /><rect x="17" y="4" width="4" height="13" rx="1" /></>,
  context_engine: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  connections: <><path d="M10 14a4 4 0 005.6 0l3-3a4 4 0 00-5.6-5.6L12 6.4M14 10a4 4 0 00-5.6 0l-3 3a4 4 0 005.6 5.6l1-1" /></>,
  clarify: <><path d="M4 5h16v11H9l-5 4z" /><path d="M10 9a2 2 0 113 1.7c-.7.4-1 .8-1 1.6M12 14h.01" /></>,
  computer_use: <><path d="M5 3l12 7-5 1.5L9.5 17z" /><path d="M13 13l5 5" /></>,
};
export function ToolIcon({ name, size = 18 }: { name: string; size?: number }) {
  return <svg className="tool-ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{TOOL_ICON[name] ?? <path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 01-12 0zM12 18v3" />}</svg>;
}

/** A toolset as a piece of gear: its icon lights when equipped; the switch says on or off; the foot says what Hermes
 *  will do (a pending change shows until the next sync). Used by the hire window and the floor's Settings. */
export function ToolSlot({ name, on, onToggle, disabled, title, foot }: { name: string; on: boolean; onToggle: () => void; disabled?: boolean; title?: string; foot?: ReactNode }) {
  const i = TOOL_INFO[name as Toolset];
  return (
    <button type="button" className={`tool-tile${on ? ' on' : ''}${i?.risky ? ' risky' : ''}`} aria-pressed={on} disabled={disabled} onClick={onToggle} title={title}>
      <span className="tt-ic"><ToolIcon name={name} /></span>
      <span className="tt-t"><b>{i?.label ?? name}</b><small>{i?.does ?? <code>{name}</code>}</small></span>
      <span className="tt-sw" aria-hidden="true"><i /></span>
      {(i?.risky || foot) && <span className="tt-tags">{i?.risky && <span className="tt-risk">Reaches outside</span>}{foot}</span>}
    </button>
  );
}

function ToolTile({ t, on, onToggle }: { t: ToolChoice; on: boolean; onToggle: () => void }) {
  if (isRequiredToolset(t.name)) return <ToolSlot name={t.name} on disabled onToggle={() => undefined} title="Every agent carries it: Vibe City needs it to run tasks." foot={<span className="tt-def">Always on</span>} />;
  return <ToolSlot name={t.name} on={on} onToggle={onToggle} disabled={!t.manageable} title={t.manageable ? undefined : 'Not a toolset Vibe City manages.'}
    foot={t.enabled ? <span className="tt-def">Hermes default</span> : undefined} />;
}

export function ToolPicker({ tools, selected, onToggle, needs }: { tools: ToolChoice[]; selected: string[]; onToggle: (t: string) => void; needs: string[] }) {
  const groups: [string, string, ToolChoice[]][] = [
    ['need', 'What this floor’s work needs', tools.filter((t) => needs.includes(t.name))],
    ['base', 'Basics every agent uses', tools.filter((t) => BASE.includes(t.name) && !needs.includes(t.name))],
    ['more', needs.length ? 'More tools (only if the work calls for them)' : 'More tools', tools.filter((t) => !needs.includes(t.name) && !BASE.includes(t.name))],
  ];
  return (
    <div className="tool-groups">
      {groups.filter(([, , g]) => g.length).map(([k, title, g]) => (
        <section key={k} aria-label={title}>
          <h4 className="tg-h">{title} <span>{g.filter((t) => selected.includes(t.name)).length}/{g.length}</span></h4>
          <div className="tool-grid">{g.map((t) => <ToolTile key={t.name} t={t} on={selected.includes(t.name)} onToggle={() => onToggle(t.name)} />)}</div>
        </section>
      ))}
    </div>
  );
}

export function SkillPicker({ installed, selected, onChange, featured }: {
  /** What Hermes has (its default profile), with whether it is on there by default. */
  installed: { name: string; enabled: boolean }[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** The template's own skills: shown first, and shown even when Hermes does not have them. */
  featured: string[];
}) {
  const [school, setSchool] = useState<School | 'all'>('all');
  const [q, setQ] = useState('');
  const def = useMemo(() => new Map(installed.map((k) => [k.name, k.enabled])), [installed]);
  const all = useMemo(() => [...new Set([...featured, ...installed.map((k) => k.name), ...selected])].map((n) => skillMeta(n)).sort(bySchool), [installed, featured, selected]);
  const counts = all.reduce<Record<string, number>>((a, m) => ({ ...a, [m.school]: (a[m.school] ?? 0) + 1 }), {});
  const match = (n: string) => { const m = skillMeta(n); return (school === 'all' || m.school === school) && (!q.trim() || `${m.name} ${m.label} ${SCHOOLS[m.school].label}`.toLowerCase().includes(q.trim().toLowerCase())); };
  const shown = all.filter((m) => match(m.name));
  const top = shown.filter((m) => featured.includes(m.name)), rest = shown.filter((m) => !featured.includes(m.name));
  const toggle = (n: string) => onChange(selected.includes(n) ? selected.filter((x) => x !== n) : [...selected, n]);
  const card = (m: (typeof all)[number]) => {
    const on = selected.includes(m.name), has = def.has(m.name);
    return <SkillCard key={m.name} name={m.name} compact pressed={on} onClick={() => toggle(m.name)}
      state={!has ? 'missing' : on ? 'active' : 'off'} note={has && def.get(m.name) ? 'Hermes default' : undefined} />;
  };
  return (
    <div className="skill-picker">
      <div className="lib-tools" role="toolbar" aria-label="Filter skills">
        <div className="lib-schools" role="group" aria-label="School">
          <button type="button" aria-pressed={school === 'all'} className={school === 'all' ? 'on' : ''} onClick={() => setSchool('all')}>All<span className="count">{all.length}</span></button>
          {(Object.keys(SCHOOLS) as School[]).filter((k) => counts[k]).map((k) => (
            <button type="button" key={k} aria-pressed={school === k} className={school === k ? 'on' : ''} style={{ ['--sk' as string]: SCHOOLS[k].color }} onClick={() => setSchool(k)}>
              <SkillGlyph school={k} size={12} />{SCHOOLS[k].label}<span className="count">{counts[k]}</span>
            </button>
          ))}
        </div>
        <label className="qb-search"><Icon n="search" size={14} /><input className="input" type="search" placeholder="Search skills" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search skills" /></label>
        <span className="sp-acts">
          <button type="button" className="link" onClick={() => onChange([...new Set([...selected, ...shown.filter((m) => def.has(m.name)).map((m) => m.name)])])}>Equip shown</button>
          <button type="button" className="link" onClick={() => onChange(selected.filter((x) => !shown.some((m) => m.name === x)))}>Clear shown</button>
        </span>
      </div>
      {top.length > 0 && <section aria-label="Built into this template"><h4 className="tg-h">Built into this template <span>{top.filter((m) => selected.includes(m.name)).length}/{top.length}</span></h4><div className="sp-grid">{top.map(card)}</div></section>}
      {rest.length > 0 && <section aria-label="The library"><h4 className="tg-h">{top.length ? 'More from the library' : 'The library'} <span>{rest.filter((m) => selected.includes(m.name)).length}/{rest.length}</span></h4><div className="sp-grid">{rest.map(card)}</div></section>}
      {shown.length === 0 && <p className="muted small">No skill matches.</p>}
    </div>
  );
}
