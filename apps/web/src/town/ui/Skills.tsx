/* Skills as game pieces (data/skills.ts says what each one is):
   - SkillGlyph / SkillBadge: the school's pixel glyph, small, for name tags, hover cards and rosters.
   - SkillCard: the collectible card, used in loadouts, an agent's deck and the library.
   - SkillLibraryWindow: every skill Hermes has, by school; inspect one and equip it on a floor.
   Equipping saves the floor's loadout; Hermes gets it at the next sync, and a card only says "Equipped" once Hermes
   reports it on. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TEMPLATES, type Inventory } from '@vibe-city/shared';
import { useStore } from '../store';
import { api } from '../../api';
import { Icon, FloorKey, useDialog } from './kit';
import { loadAgent, loadHermesDefaults, patchInventory, provisionDepartment } from '../data/live';
import { SCHOOLS, RARITY_LABEL, STATE_LABEL, bySchool, skillMeta, skillState, templateSkills, toggleAllowance, type School, type SkillState } from '../data/skills';

/* ---------------- glyphs: 8x8 pixel art per school ('#' ink, '+' highlight) ---------------- */

const GLYPHS: Record<School, string[]> = {
  core: ['...##...', '...++...', '.######.', '##+##+##', '.######.', '..####..', '.##..##.', '##....##'],
  wallet: ['..####..', '.#++++#.', '#+#..#+#', '#+.##.+#', '#+.##.+#', '#+#..#+#', '.#++++#.', '..####..'],
  markets: ['......#.', '..#...#.', '.###.+#+', '.###.+#+', '.###.+#+', '.+#+..#.', '.+#+....', '..#.....'],
  code: ['........', '.#....#.', '#....+.#', '#...+..#', '#..+...#', '#.+....#', '.#....#.', '........'],
  research: ['.####...', '#++++#..', '#+...#..', '#+...#..', '#....#..', '.####+#.', '.....+##', '......##'],
  docs: ['.#####..', '.#+++##.', '.#....#.', '.#+++.#.', '.#....#.', '.#+++.#.', '.#....#.', '.######.'],
  security: ['.######.', '#++++++#', '#+.##.+#', '#+.##.+#', '#+....+#', '.#+..+#.', '..#++#..', '...##...'],
  creative: ['......##', '.....#+#', '....#+#.', '...#+#..', '..##+...', '.#++#...', '#++#....', '##......'],
  comms: ['.######.', '#++++++#', '#+.+.+.#', '#++++++#', '.######.', '..#.....', '.#......', '........'],
  ops: ['...##...', '.#.##.#.', '..####..', '##+..+##', '##+..+##', '..####..', '.#.##.#.', '...##...'],
};

export function SkillGlyph({ school, size = 16 }: { school: School; size?: number }) {
  const { color, deep } = SCHOOLS[school];
  const cells = GLYPHS[school];
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden="true" className="sk-glyph">
      {cells.flatMap((row, y) => [...row].map((ch, x) => (ch === '.' ? null : <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={ch === '+' ? '#FFFFFF' : color} opacity={ch === '+' ? 0.85 : 1} />)))}
      <rect x="0" y="7.6" width="8" height=".4" fill={deep} opacity=".6" />
    </svg>
  );
}

/** A small square badge: the skill's glyph in its school colours. The name is in the title and for screen readers. */
export function SkillBadge({ name, size = 18, state, essential }: { name: string; size?: number; state?: SkillState; essential?: boolean }) {
  const m = skillMeta(name, essential);
  const { color, deep } = SCHOOLS[m.school];
  const dim = state && state !== 'active';
  return (
    <span className={`sk-badge r-${m.rarity}${dim ? ' dim' : ''}`} style={{ ['--sk' as string]: color, ['--skd' as string]: deep, width: size + 8, height: size + 8 }} title={`${m.label} · ${SCHOOLS[m.school].label}${state ? ` · ${STATE_LABEL[state]}` : ''}`}>
      <SkillGlyph school={m.school} size={size} /><span className="sr">{m.label}</span>
    </span>
  );
}

/** Up to `max` badges and a "+n". */
export function SkillBadges({ names, max = 4, size = 12 }: { names: string[]; max?: number; size?: number }) {
  if (!names.length) return null;
  const shown = [...names].map((n) => skillMeta(n)).sort(bySchool).slice(0, max);
  return (
    <span className="sk-badges" aria-label={`Skills: ${names.map((n) => skillMeta(n).label).join(', ')}`}>
      {shown.map((m) => <SkillBadge key={m.name} name={m.name} size={size} />)}
      {names.length > max && <span className="sk-more">+{names.length - max}</span>}
    </span>
  );
}

/* ---------------- the card ---------------- */

const STATE_TONE: Record<SkillState, string> = { active: 'ok', 'pending-on': 'pend', 'pending-off': 'pend', off: 'idle', missing: 'bad' };

export function SkillCard({ name, essential, state, own, compact, selected, onClick, action, note }: {
  name: string; essential?: boolean; state?: SkillState; own?: boolean; compact?: boolean; selected?: boolean;
  onClick?: () => void; action?: ReactNode; note?: ReactNode;
}) {
  const m = skillMeta(name, essential);
  const s = SCHOOLS[m.school];
  const body = (
    <>
      <span className="sk-top"><span className="sk-school">{s.label}</span>{m.wallet && m.school !== 'wallet' && <span className="sk-flag" title="Spends from the company wallet, inside the wallet policy"><Icon n="lock" size={10} />Wallet</span>}<span className={`sk-gem r-${m.rarity}`} title={RARITY_LABEL[m.rarity]} /></span>
      <span className="sk-mid">
        <span className="sk-tile"><SkillGlyph school={m.school} size={compact ? 22 : 30} /></span>
        <span className="sk-name"><b>{m.label}</b><code>{m.name}</code></span>
      </span>
      {!compact && <span className="sk-blurb">{m.blurb}</span>}
      {(state || own || note) && (
        <span className="sk-foot">
          {own && <span className="sk-own">Own</span>}
          {state && <span className={`sk-state ${STATE_TONE[state]}`}>{STATE_LABEL[state]}</span>}
          {note && <span className="sk-note">{note}</span>}
        </span>
      )}
    </>
  );
  const cls = `sk-card r-${m.rarity}${compact ? ' compact' : ''}${selected ? ' sel' : ''}${state && STATE_TONE[state] === 'idle' ? ' idle' : ''}`;
  const style = { ['--sk' as string]: s.color, ['--skd' as string]: s.deep };
  return (
    <div className={cls} style={style}>
      {onClick ? <button type="button" className="sk-hit" onClick={onClick} aria-pressed={selected}>{body}</button> : <div className="sk-hit">{body}</div>}
      {action && <div className="sk-act">{action}</div>}
    </div>
  );
}

/* ---------------- Hermes' skills (the default profile), read once per session ---------------- */

let installed: Promise<{ names: { name: string; enabled: boolean }[]; error: string | null }> | null = null;
export function useInstalledSkills() {
  const [v, setV] = useState<{ names: { name: string; enabled: boolean }[]; error: string | null } | null>(null);
  useEffect(() => {
    installed ??= loadHermesDefaults().then((r) => {
      if (r.error) installed = null; // try again next time
      return { names: r.value?.skills ?? [], error: r.error?.message ?? null };
    });
    let live = true;
    void installed.then((x) => { if (live) setV(x); });
    return () => { live = false; };
  }, []);
  return v;
}

/* ---------------- the library window ---------------- */

export function SkillLibraryWindow() {
  const lib = useStore((s) => s.ui.skillLib);
  return lib ? <SkillLibrary deptId={lib.deptId} first={lib.skill} /> : null;
}

const templatesUsing = (name: string) => TEMPLATES.filter((t) => !t.hidden && (t.inventory.allowedSkillIds.includes(name) || t.seats.some((x) => x.skills.includes(name)))).map((t) => t.name);

function SkillLibrary({ deptId, first }: { deptId: string | null; first: string | null }) {
  const depts = useStore((s) => s.depts);
  const agents = useStore((s) => s.agents);
  const busy = useStore((s) => s.busy);
  const hermesUp = useStore((s) => s.conn.hermes);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => useStore.getState().ui$({ skillLib: null });
  useDialog(ref, true, close);
  const lib = useInstalledSkills();
  const [invs, setInvs] = useState<Record<string, Inventory>>({});
  const [school, setSchool] = useState<School | 'all'>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(first);
  const ready = depts;
  const reloadInvs = () => Promise.all(ready.map((d) => api.inventory(d.id).then((i) => [d.id, i] as const).catch(() => null)))
    .then((rows) => setInvs(Object.fromEntries(rows.filter((r): r is readonly [string, Inventory] => !!r))));
  useEffect(() => { void reloadInvs(); for (const d of ready) if (!agents[`${d.id}:chief`]?.view) void loadAgent(d.id, 'chief'); }, [ready.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const defaultsOn = useMemo(() => (lib?.names ?? []).filter((k) => k.enabled).map((k) => k.name), [lib]);
  // every skill Hermes has, plus the ones a template asks for that Hermes does not have yet
  const all = useMemo(() => {
    const names = new Set([...(lib?.names ?? []).map((k) => k.name), ...templateSkills()]);
    return [...names].map((n) => skillMeta(n)).sort(bySchool);
  }, [lib]);
  const inHermes = useMemo(() => new Set((lib?.names ?? []).map((k) => k.name)), [lib]);
  const counts = useMemo(() => all.reduce<Record<string, number>>((a, m) => ({ ...a, [m.school]: (a[m.school] ?? 0) + 1 }), {}), [all]);
  const shown = all.filter((m) => (school === 'all' || m.school === school) && (!q.trim() || `${m.name} ${m.label} ${SCHOOLS[m.school].label}`.toLowerCase().includes(q.trim().toLowerCase())));
  const pick = sel && all.some((m) => m.name === sel) ? sel : shown[0]?.name ?? null;
  const meta = pick ? all.find((m) => m.name === pick)! : null;

  const stateOn = (dId: string, name: string): SkillState => {
    const v = agents[`${dId}:chief`]?.view;
    return skillState(name, invs[dId]?.allowedSkillIds ?? [], defaultsOn, v?.observedAt ? v.skills : null);
  };
  const floorsWith = (name: string) => ready.filter((d) => ['active', 'pending-on'].includes(stateOn(d.id, name))).length;
  const equip = async (dId: string, name: string, on: boolean) => {
    const inv = invs[dId]; if (!inv) return;
    await patchInventory(dId, { allowedSkillIds: toggleAllowance(inv.allowedSkillIds, defaultsOn, name, on) });
    await reloadInvs();
  };
  const sync = async (dId: string) => { await provisionDepartment(dId); void loadAgent(dId, 'chief'); };
  const owners = (name: string) => ready.flatMap((d) => d.view.agents.filter((a) => a.skills.includes(name)).map((a) => ({ d, a })));
  const floorNo = (id: string) => depts.length - depts.findIndex((d) => d.id === id);
  // the floor the library was opened from goes first
  const floors = [...ready].sort((a, b) => Number(b.id === deptId) - Number(a.id === deptId));

  return (
    <div className="hire-scrim" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="hire exec-modal lib" ref={ref} role="dialog" aria-modal="true" aria-labelledby="lib-t">
        <header className="hire-head">
          <div><span className="dlg-tag">Hermes · {inHermes.size} skill{inHermes.size === 1 ? '' : 's'} installed</span><h2 id="lib-t">Skill library</h2></div>
          <button className="dlg-icon" onClick={close} aria-label="Close"><Icon n="x" size={14} /></button>
        </header>
        <p className="lib-lead">Every skill your Hermes has. Pick one to see who uses it, and equip it on a floor: it reaches the agents at the floor’s next sync.</p>
        <div className="lib-tools" role="toolbar" aria-label="Filter skills">
          <div className="lib-schools" role="group" aria-label="School">
            <button aria-pressed={school === 'all'} className={school === 'all' ? 'on' : ''} onClick={() => setSchool('all')}>All<span className="count">{all.length}</span></button>
            {(Object.keys(SCHOOLS) as School[]).filter((k) => counts[k]).map((k) => (
              <button key={k} aria-pressed={school === k} className={school === k ? 'on' : ''} style={{ ['--sk' as string]: SCHOOLS[k].color }} onClick={() => setSchool(k)}>
                <SkillGlyph school={k} size={12} />{SCHOOLS[k].label}<span className="count">{counts[k]}</span>
              </button>
            ))}
          </div>
          <label className="qb-search"><Icon n="search" size={14} /><input className="input" type="search" placeholder="Search skills" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search skills" /></label>
        </div>
        {lib?.error && <p className="err-t" role="alert">Could not read Hermes’ skills: {lib.error}</p>}
        {!lib && <p className="muted small" role="status">Reading Hermes’ skills…</p>}

        <div className="lib-cols">
          <div className="lib-grid" role="list" aria-label="Skills">
            {shown.map((m) => {
              const n = floorsWith(m.name);
              return (
                <div role="listitem" key={m.name}>
                  <SkillCard name={m.name} compact selected={m.name === pick} onClick={() => setSel(m.name)}
                    state={inHermes.has(m.name) ? undefined : 'missing'}
                    note={inHermes.has(m.name) ? (n ? `On ${n} floor${n === 1 ? '' : 's'}` : 'On no floor') : undefined} />
                </div>
              );
            })}
            {lib && shown.length === 0 && <p className="muted small">No skill matches.</p>}
          </div>

          {meta && (
            <aside className="lib-inspect" aria-label={`${meta.label}: details`}>
              <SkillCard name={meta.name} state={inHermes.has(meta.name) ? undefined : 'missing'} />
              <dl className="lib-facts">
                <div><dt>School</dt><dd>{SCHOOLS[meta.school].label}</dd></div>
                <div><dt>Rarity</dt><dd>{RARITY_LABEL[meta.rarity]}{meta.rarity === 'signature' && templatesUsing(meta.name).length > 0 && <small> · built into {templatesUsing(meta.name).join(', ')}</small>}</dd></div>
                {meta.wallet && <div><dt>Money</dt><dd>Spends from the company wallet, only inside the policy you set.</dd></div>}
              </dl>
              {!inHermes.has(meta.name) && <p className="banner warn small-banner">Hermes does not have this skill yet. A template names it, but it has to be installed in Hermes before a floor can use it.</p>}

              <h3 className="sec-t">On your floors</h3>
              {floors.length === 0 && <p className="muted small">No floors yet.</p>}
              <ul className="lib-floors">
                {floors.map((d) => {
                  const st = stateOn(d.id, meta.name);
                  const on = st === 'active' || st === 'pending-on' || st === 'missing';
                  const essential = !!agents[`${d.id}:chief`]?.view?.skills.find((k) => k.name === meta.name)?.essential;
                  const saving = !!busy[`inv:${d.id}`] || !!busy[`provision:${d.id}`];
                  return (
                    <li key={d.id} className={d.id === deptId ? 'here' : ''}>
                      <span className="lib-fl"><FloorKey n={String(floorNo(d.id))} />{d.name}{d.id === deptId && <small className="muted">this floor</small>}</span>
                      <span className={`sk-state ${STATE_TONE[st]}`}>{STATE_LABEL[st]}</span>
                      <span className="lib-fa">
                        {(st === 'pending-on' || st === 'pending-off') && <button className="btn secondary small" disabled={saving || !hermesUp} onClick={() => void sync(d.id)}>{busy[`provision:${d.id}`] ? 'Syncing…' : 'Sync'}</button>}
                        {!essential && inHermes.has(meta.name) && <button className={`btn ${on ? 'tertiary' : 'primary'} small`} disabled={saving || !invs[d.id]} onClick={() => void equip(d.id, meta.name, !on)}>{on ? 'Unequip' : 'Equip'}</button>}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {owners(meta.name).length > 0 && <>
                <h3 className="sec-t">Agents who brought it</h3>
                <p className="fine">Their own skill from their hire: they keep it whatever the floor’s loadout says.</p>
                <ul className="lib-owners">{owners(meta.name).map(({ d, a }) => <li key={`${d.id}:${a.key}`}><FloorKey n={String(floorNo(d.id))} tone="dim" />{a.title ?? (a.lead ? 'Lead' : a.key)} <span className="muted small">· {d.name}</span></li>)}</ul>
              </>}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

