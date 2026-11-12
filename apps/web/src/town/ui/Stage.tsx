import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import type { City } from '../world/City';
import { refreshAll } from '../data/live';
import { FloorKey, Glyph, Icon, deptStatus, statusColor, type StatusKey } from './kit';
import { EXEC_OBJECTS } from '../world/execRoom';
import { execAction, floorAction } from '../execActions';
import { floorObjects } from '../world/floorRoom';
import { FLOOR_OBJECT_HELP, listedFloors, stationFor, stationKeyOf } from '../data/floor';
import { loadPersonas } from './AgentView';
import { agentLabel, bubbleText } from '../data/views';
import { PortraitCanvas } from './Dialogue';
import { lookFor, quirkProp } from '../world/sprites';
import { SkillBadges } from './Skills';
import { play } from '../sfx';

/* DOM layer over the canvas: floor signs, the floor rail, HQ card, zoom and toasts.
   Positions come from the renderer's anchors every frame and are written straight to style,
   so React never re-renders per frame. */
export function StageOverlay({ city }: { city: City | null }) {
  const depts = useStore((s) => s.depts);
  const personas = useStore((s) => s.personas);
  const ui = useStore((s) => s.ui);
  const toasts = useStore((s) => s.toasts);
  const conn = useStore((s) => s.conn);
  const loaded = useStore((s) => s.loaded);
  const openFloor = useStore((s) => s.openFloor);
  const closeFloor = useStore((s) => s.closeFloor);
  const ui$ = useStore((s) => s.ui$);
  const refs = useRef(new Map<string, HTMLElement>());
  /** Each speech bubble's text and when it last changed (a new line shows at once, for a while). */
  const says = useRef(new Map<string, { text: string; since: number }>());
  const n = depts.length;
  // bubble texts age (a fresh note gives way, a recap fades): re-read them now and then
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 20_000); return () => window.clearInterval(id); }, []);
  const [hovered, setHovered] = useState<string | null>(null);
  const hoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!city) return;
    let raf = 0;
    const loop = () => {
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      for (const a of city.anchors) {
        const el = refs.current.get(a.kind === 'agent' ? 'agent:' + a.id : a.id);
        if (!el) continue;
        let x = Math.round(a.x), y = Math.round(a.y), show = a.visible;
        if (a.kind === 'agent') {
          // name tags only for the agent you point at or picked, and for anyone who failed
          const want = el.classList.contains('sel') || city.hoverAgent === a.id || el.dataset.st === 'failed';
          show = want ? a.visible : 0;
          if (show > 0.5) {
            const w = el.offsetWidth, h = el.offsetHeight;
            for (const p of placed) if (Math.abs(p.x - x) < (p.w + w) / 2 + 4 && Math.abs(p.y - y) < h + 2) y = p.y - h - 4;
            placed.push({ x, y, w, h });
          }
          el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
        } else if (a.kind === 'obj') {
          el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
          el.classList.toggle('hot', city.hoverObj === a.id.slice(4));
        } else el.style.transform = `translate(${x}px, ${y}px)`;
        el.style.opacity = String(show);
        el.style.pointerEvents = show > 0.5 ? 'auto' : 'none';
        el.tabIndex = show > 0.5 ? 0 : -1;
      }
      // speech bubbles: an agent's note on its work shows for a few seconds when it changes, and while you point at the
      // agent; otherwise the floor stays clear of text
      const ids = [...refs.current.keys()].filter((k) => k.startsWith('say:')).map((k) => k.slice(4));
      const talkers = ids.filter((id) => refs.current.get('say:' + id)?.dataset.text);
      const tnow = performance.now();
      const ui = useStore.getState().ui, bubbles: { el: HTMLElement; x: number; y: number; show: boolean }[] = [];
      // one bubble at a time besides the one you point at: the newest line, for 8 s; and
      // while people talk out loud (a hello, a task handed over), only they speak
      for (const id of ids) { const text = refs.current.get('say:' + id)!.dataset.text ?? '', st = says.current.get(id); if (!st || st.text !== text) says.current.set(id, { text, since: tnow }); }
      const fresh = talkers.map((id) => ({ id, since: says.current.get(id)!.since })).filter((x) => tnow - x.since < 8000).sort((p, q) => q.since - p.since)[0]?.id ?? null;
      const talking = !!ui.floorId && ids.some((id) => city.lineOf(ui.floorId!, id));
      for (const id of ids) {
        const el = refs.current.get('say:' + id)!, text = el.dataset.text ?? '';
        const at = city.anchors.find((x) => x.kind === 'agent' && x.id === id);
        const named = city.hoverAgent === id || ui.agent === id;
        // something said out loud (a hello, a task handed over) beats the note on what they are working on
        const line = ui.floorId ? city.lineOf(ui.floorId, id) : null, spoken = el.lastElementChild as HTMLElement;
        if (line && spoken.textContent !== line) spoken.textContent = line;
        el.classList.toggle('spoke', !!line);
        const show = !!at && at.visible > 0.5 && !ui.talk && (!!line || (!!text && (city.hoverAgent === id || (!talking && id === fresh))));
        el.classList.toggle('on', show);
        if (at) bubbles.push({ el, x: Math.round(at.x), y: Math.round(at.y - (named ? 30 : 8)), show });
      }
      // bubbles never sit on top of each other: one further back moves up above the one in front
      const shown: { x: number; y: number; w: number; h: number }[] = [];
      for (const bb of bubbles.sort((p, q) => q.y - p.y)) {
        let y = bb.y;
        if (bb.show) {
          const w = bb.el.offsetWidth, h = bb.el.offsetHeight;
          for (let pass = 0; pass < 3; pass++) for (const o of shown) if (Math.abs(o.x - bb.x) < (o.w + w) / 2 + 4 && y > o.y - o.h - 4 && y - h < o.y + 4) y = o.y - o.h - 4;
          shown.push({ x: bb.x, y, w, h });
        }
        bb.el.style.transform = `translate(${bb.x}px, ${y}px) translate(-50%, -100%)`;
      }
      // hover card follows the agent under the pointer
      const hv = city.hoverAgent;
      setHovered((prev) => (prev === hv ? prev : hv));
      const card = hoverRef.current;
      if (card && hv) {
        const a = city.anchors.find((x) => x.kind === 'agent' && x.id === hv);
        if (a) card.style.transform = `translate(${Math.round(a.x + 18)}px, ${Math.round(a.y - 10)}px)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [city]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || useStore.getState().ui.modal || useStore.getState().ui.talk || useStore.getState().ui.newDept) return;
      const s = useStore.getState();
      const floorOpen = s.ui.view === 'floor' && !!s.ui.floorId;
      if (s.ui.execModal) { s.ui$({ execModal: null }); return; }
      if (s.ui.panel === 'quest') s.openPanel(s.ui.questFrom === 'dept' && floorOpen ? 'dept' : 'board');
      else if (s.ui.panel === 'board' && s.ui.boardQuest) s.ui$({ boardQuest: null });
      else if (s.ui.panel === 'board') s.openPanel(floorOpen ? 'dept' : 'exec');
      else if (s.ui.panel === 'settings' || s.ui.panel === 'agent') s.openPanel('dept');
      else if (s.ui.view === 'floor' || s.ui.execRoom) s.closeFloor();
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openId = ui.view === 'floor' ? ui.floorId : null;
  const seatKeys = useMemo(() => { const d = depts.find((x) => x.id === openId); return d ? [...(d.chief ? ['chief'] : []), ...d.workers.map((w) => w.id)] : []; }, [depts, openId]);
  useEffect(() => { if (openId && seatKeys.length) loadPersonas(openId, seatKeys); }, [openId, seatKeys.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (id: string) => (el: HTMLElement | null) => { if (el) refs.current.set(id, el); else refs.current.delete(id); };
  const openDept = ui.view === 'floor' ? depts.find((d) => d.id === ui.floorId) : null;
  const market = useStore((s) => s.market);
  const wide = ui.panel === 'dept' || ui.panel === 'exec' || ui.panel === 'agent';

  return (
    <div className="overlay">
      {/* floor signs */}
      {wide && (
        <div className="signs">
          <button ref={set('ph')} className={`sign ph${ui.panel === 'exec' && ui.view === 'tower' ? ' sel' : ''}`} onClick={() => useStore.getState().openExec()} aria-label="Executive office: go inside">
            <span className="line" /><b className="fkey gold">PH</b>Executive office
          </button>
          <button ref={set('ghost')} className="sign ghost" onClick={() => ui$({ modal: 'create' })}><span className="line" /><Icon n="plus" size={14} sw={3} />Add floor</button>
          {depts.map((d, i) => {
            const st = deptStatus(d.state); const sel = ui.floorId === d.id;
            return (
              <button key={d.id} ref={set(d.id)} className={`sign${sel ? ' sel' : ''}${d.state === 'unconfigured' ? ' warn' : ''}`} onClick={() => openFloor(d.id)} aria-label={`F${n - i} ${d.name}, ${st.label}`}>
                <span className="line" /><b className={`fkey ${d.state === 'unconfigured' ? 'amber' : d.state === 'offline' ? 'dim' : 'cyan'}`}>F{n - i}</b>{d.name}<Glyph k={st.k} />
              </button>
            );
          })}
        </div>
      )}
      {/* hover card: who this is and what they are doing (feature spec 2.5) */}
      {openDept && hovered && !ui.talk && <HoverCard ref_={hoverRef} deptId={openDept.id} agentKey={hovered} />}
      {/* name tags for people in the open office */}
      {openDept && (
        <div className="tags">
          {[...(openDept.chief ? [{ id: 'chief', label: agentLabel('chief', personas[`${openDept.id}:chief`]), title: openDept.chief.title, k: openDept.chief.status as StatusKey }] : []), ...openDept.workers.map((w) => ({ id: w.id, label: agentLabel(w.id, personas[`${openDept.id}:${w.id}`]), title: w.title, k: w.status as StatusKey }))].map((t) => (
            <button key={t.id} ref={set('agent:' + t.id)} data-st={t.k} className={`tag${ui.agent === t.id ? ' sel' : ''}${t.id === 'chief' ? ' chief' : ''}`}
              {...holdToTalk(() => ui$({ agent: t.id, talk: { deptId: openDept.id, agentKey: t.id } }), () => { city?.greet(openDept.id, t.id); useStore.getState().openPanel('agent', { agent: t.id }); })}
              onDoubleClick={() => ui$({ agent: t.id, talk: { deptId: openDept.id, agentKey: t.id } })}>
              <Glyph k={t.k} />{t.label}{t.title && <small className="tag-title">{t.title}</small>}<SkillBadges names={openDept.view.agents.find((a) => (t.id === 'chief' ? a.lead : a.key === t.id))?.skills ?? []} max={3} size={9} />
            </button>
          ))}
        </div>
      )}

      {/* speech bubbles: what each agent is up to, in a few words */}
      {openDept && (
        <div className="says" aria-hidden="true">
          {[...(openDept.chief ? [{ id: 'chief', said: openDept.chief.said }] : []), ...openDept.workers.map((w) => ({ id: w.id, said: w.said }))]
            .map((a) => ({ id: a.id, text: bubbleText(a.said, now) ?? '' }))
            .map((a) => <div key={a.id} ref={set('say:' + a.id)} className="say" data-text={a.text}><span>{a.text}</span><span className="say-line" /></div>)}
        </div>
      )}
      {/* Executive Office: every object is a control; the labels are its keyboard path */}
      {ui.execRoom && (
        <div className="tags objs" aria-label="Executive office">
          {EXEC_OBJECTS.map((o) => (
            <button key={o.id} ref={set('obj:' + o.id)} className="tag obj" onClick={() => execAction(o.id)}
              onMouseEnter={() => { if (city) city.hoverObj = o.id; }} onMouseLeave={() => { if (city) city.hoverObj = null; }}
              onFocus={() => { if (city) city.hoverObj = o.id; }} onBlur={() => { if (city) city.hoverObj = null; }} aria-label={o.label}><span aria-hidden="true">{o.label}</span></button>
          ))}
        </div>
      )}
      {/* A department floor: its controls, same as the Executive Office's */}
      {openDept && !ui.execRoom && (
        <div className="tags objs" aria-label={`${openDept.name}: controls`}>
          {floorObjects(stationFor(stationKeyOf(openDept, listedFloors(market)))?.name ?? null).map((o) => (
            <button key={o.id} ref={set('obj:' + o.id)} className="tag obj" onClick={() => floorAction(o.id, openDept.id)} title={FLOOR_OBJECT_HELP[o.id]}
              onMouseEnter={() => { if (city) city.hoverObj = o.id; }} onMouseLeave={() => { if (city) city.hoverObj = null; }}
              onFocus={() => { if (city) city.hoverObj = o.id; }} onBlur={() => { if (city) city.hoverObj = null; }} aria-label={`${o.label}: ${FLOOR_OBJECT_HELP[o.id]}`}><span aria-hidden="true">{o.label}</span></button>
          ))}
        </div>
      )}
      {ui.execRoom && (
        <div className="crumb">
          <button className="btn tertiary" onClick={closeFloor}><Icon n="back" />Tower</button>
          <span className="crumb-label"><FloorKey n="PH" tone="gold" />Executive office</span>
          <span className="kbd">Esc</span>
        </div>
      )}
      {ui.view === 'floor' && openDept && (
        <div className="crumb">
          <button className="btn tertiary" onClick={closeFloor}><Icon n="back" />Tower</button>
          <span className="crumb-label"><FloorKey n={'F' + (n - depts.indexOf(openDept))} />{openDept.name}</span>
          <span className="kbd">Esc</span>
        </div>
      )}

      {/* floor rail */}
      {wide && (
        <nav className="rail" aria-label="Floors">
          <LiftDisplay n={n} at={openDept ? n - depts.indexOf(openDept) : ui.execRoom ? n + 1 : null} />
          <button className={`rail-b ph${ui.execRoom ? ' sel' : ''}`} onClick={() => useStore.getState().openExec()} title="Executive office" aria-label="PH Executive office: go inside">PH</button>
          {depts.map((d, i) => (
            <button key={d.id} className={`rail-b${ui.floorId === d.id ? ' sel' : ''}`} onClick={() => openFloor(d.id)} title={d.name} aria-label={`F${n - i} ${d.name}`}>
              {n - i}<i style={{ background: statusColor(deptStatus(d.state).k), color: statusColor(deptStatus(d.state).k) }} />
            </button>
          ))}
          <span className="lift-plate" aria-hidden="true">Lift</span>
        </nav>
      )}

      {/* bottom: camera */}
      {wide && ui.view === 'tower' && !ui.execRoom && (
        <div className="zoom">
          <button className="zb" onClick={() => city?.zoomBy(0.85)} aria-label="Zoom out"><Icon n="minus" /></button>
          <button className="zb" onClick={() => city?.zoomBy(1.18)} aria-label="Zoom in"><Icon n="plus" /></button>
          <button className="zb wide" onClick={() => city?.fit()}><Icon n="fit" />Fit tower</button>
        </div>
      )}

      {!conn.backend ? (
        <div className="stage-alert">
          <Glyph k="failed" /><span><b>Can’t reach the Vibe City backend.</b> Floors show the last data received and may be out of date.</span>
          <button className="btn destructive" onClick={() => void refreshAll()}>Retry now</button>
        </div>
      ) : !conn.hermes ? (
        <div className="stage-alert">
          <Glyph k="failed" /><span><b>Can’t reach Hermes.</b> Floors show their last known state; jobs can’t be created or changed.</span>
          <button className="btn destructive" onClick={() => void refreshAll()}>Retry now</button>
        </div>
      ) : !conn.gateway && depts.some((d) => d.provisioning === 'ready') ? (
        <div className="stage-alert">
          <Glyph k="awaiting" /><span><b>The Hermes gateway isn’t running.</b> Queued work won’t start until it is.</span>
        </div>
      ) : null}
      {!loaded && conn.backend && <div className="stage-alert"><Glyph k="running" /><span>Loading the tower from the backend…</span></div>}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}><Glyph k={t.tone === 'bad' ? 'failed' : t.tone === 'warn' ? 'awaiting' : 'completed'} />{t.text}</div>)}
      </div>
    </div>
  );
}

function HoverCard({ ref_, deptId, agentKey }: { ref_: React.RefObject<HTMLDivElement | null>; deptId: string; agentKey: string }) {
  const d = useStore((s) => s.depts.find((x) => x.id === deptId));
  const ch = useStore((s) => s.personas[`${deptId}:${agentKey}`]);
  const w = agentKey === 'chief' ? null : d?.workers.find((x) => x.id === agentKey) ?? null;
  const look = useMemo(() => ({ ...lookFor(deptId + ':' + agentKey, w?.shirt ?? '#FFFFFF', agentKey === 'chief'), prop: quirkProp(ch?.quirk) }), [deptId, agentKey, w?.shirt, ch?.quirk]);
  if (!d) return null;
  const own = d.view.agents.find((a) => (agentKey === 'chief' ? a.lead : a.key === agentKey))?.skills ?? [];
  const status = agentKey === 'chief' ? d.chief?.status ?? 'awaiting' : w?.status ?? 'idle';
  const doing = agentKey === 'chief' ? d.chief?.activity ?? '' : w ? (w.status === 'completed' ? `Done: ${w.task}` : w.task) : '';
  return (
    <div className="hovercard" ref={ref_} aria-hidden="true" style={{ ['--who' as string]: ch?.color ?? '#FFC75A' }}>
      <div className="hc-face"><PortraitCanvas look={look} mood={status === 'failed' ? 'worried' : status === 'running' ? 'focused' : 'neutral'} talking={false} size={48} className="hc-portrait" /></div>
      <div className="hc-body">
        <b>{agentLabel(agentKey, ch)}</b>
        <span className="hc-role">{ch?.title ?? (agentKey === 'chief' ? 'Lead' : 'Teammate')}</span>
        <span className="hc-doing"><Glyph k={status as StatusKey} /> {doing || deptStatus(d.state).label}</span>
        {own.length > 0 && <span className="hc-skills"><SkillBadges names={own} max={5} size={11} /><small>{own.length === 1 ? 'own skill' : 'own skills'}</small></span>}
        <span className="hc-hint">Click for profile · hold to talk</span>
      </div>
    </div>
  );
}

/** Name tags: click opens the profile; holding (touch, pen or mouse) for half a second opens the chat instead. */
const HOLD_MS = 500;
const holds = new WeakMap<EventTarget, { timer: number; fired: boolean; x: number; y: number }>();
function holdToTalk(onHold: () => void, onClick: () => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const el = e.currentTarget, h = { timer: 0, fired: false, x: e.clientX, y: e.clientY };
      h.timer = window.setTimeout(() => { h.fired = true; try { navigator.vibrate?.(15); } catch { /* not supported */ } onHold(); }, HOLD_MS);
      holds.set(el, h);
    },
    onPointerMove: (e: React.PointerEvent) => { const h = holds.get(e.currentTarget); if (h && !h.fired && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 8) { window.clearTimeout(h.timer); holds.delete(e.currentTarget); } },
    onPointerUp: (e: React.PointerEvent) => {
      const el = e.currentTarget, h = holds.get(el); if (!h) return;
      if (!h.fired) { window.clearTimeout(h.timer); holds.delete(el); return; }
      // touch browsers may not send a click after a hold: never let it swallow a later tap
      setTimeout(() => { if (holds.get(el) === h) holds.delete(el); }, 400);
    },
    onPointerCancel: (e: React.PointerEvent) => { const h = holds.get(e.currentTarget); if (h) { window.clearTimeout(h.timer); holds.delete(e.currentTarget); } },
    onContextMenu: (e: React.MouseEvent) => { if (holds.has(e.currentTarget)) e.preventDefault(); },
    onClick: (e: React.MouseEvent) => {
      const h = holds.get(e.currentTarget); holds.delete(e.currentTarget);
      if (h?.fired) return; // the hold already opened the chat
      onClick();
    },
  };
}

/** The lift's floor display: when you pick a floor it counts through the floors in between (a click each), then
    rings once on arrival; the tower view shows how many floors there are. PH is the floor above the top one. */
function LiftDisplay({ n, at }: { n: number; at: number | null }) {
  const [shown, setShown] = useState<number | null>(at);
  const [dir, setDir] = useState<'up' | 'down'>('up');
  useEffect(() => {
    if (at === null || shown === null || at === shown) { if (shown === null) setDir('up'); setShown(at); return; } // from the tower: always up
    setDir(at > shown ? 'up' : 'down');
    const id = window.setTimeout(() => {
      const next = shown + (at > shown ? 1 : -1);
      setShown(next);
      play(next === at ? 'lift' : 'pass');
    }, 150);
    return () => window.clearTimeout(id);
  }, [at, shown]);
  const label = shown === null ? n + 1 : shown === n + 1 ? 'PH' : shown;
  return (
    <div className={`rail-disp${shown !== at ? ' moving' : ''}`} aria-live="polite" title={`${n + 1} floors: the Executive Office and ${n} more`}>
      <span className="rail-arrow" aria-hidden="true">{shown === null ? '▲' : dir === 'up' ? '▲' : '▼'}</span>{label}
    </div>
  );
}
