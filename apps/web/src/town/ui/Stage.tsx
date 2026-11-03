import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import type { City } from '../world/City';
import { refreshAll } from '../data/live';
import { FloorKey, Glyph, Icon, deptStatus, statusColor, type StatusKey } from './kit';

/* DOM layer over the canvas: floor signs, the floor rail, HQ card, legend, zoom and toasts.
   Positions come from the renderer's anchors every frame and are written straight to style,
   so React never re-renders per frame. */
export function StageOverlay({ city }: { city: City | null }) {
  const depts = useStore((s) => s.depts);
  const ui = useStore((s) => s.ui);
  const toasts = useStore((s) => s.toasts);
  const conn = useStore((s) => s.conn);
  const loaded = useStore((s) => s.loaded);
  const openFloor = useStore((s) => s.openFloor);
  const closeFloor = useStore((s) => s.closeFloor);
  const ui$ = useStore((s) => s.ui$);
  const refs = useRef(new Map<string, HTMLElement>());
  const n = depts.length;

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
        } else el.style.transform = `translate(${x}px, ${y}px)`;
        el.style.opacity = String(show);
        el.style.pointerEvents = show > 0.5 ? 'auto' : 'none';
        el.tabIndex = show > 0.5 ? 0 : -1;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [city]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || useStore.getState().ui.modal) return;
      const s = useStore.getState();
      const floorOpen = s.ui.view === 'floor' && !!s.ui.floorId;
      if (s.ui.panel === 'quest') s.openPanel(s.ui.questFrom === 'dept' && floorOpen ? 'dept' : 'board');
      else if (s.ui.panel === 'board') s.openPanel(floorOpen ? 'dept' : 'exec');
      else if (s.ui.panel === 'inventory' || s.ui.panel === 'settings' || s.ui.panel === 'agent') s.openPanel('dept');
      else if (s.ui.view === 'floor') s.closeFloor();
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);

  const set = (id: string) => (el: HTMLElement | null) => { if (el) refs.current.set(id, el); else refs.current.delete(id); };
  const openDept = ui.view === 'floor' ? depts.find((d) => d.id === ui.floorId) : null;
  const wide = ui.panel === 'dept' || ui.panel === 'exec' || ui.panel === 'agent';

  return (
    <div className="overlay">
      {/* floor signs */}
      {wide && (
        <div className="signs">
          <button ref={set('ph')} className={`sign ph${ui.panel === 'exec' && ui.view === 'tower' ? ' sel' : ''}`} onClick={() => closeFloor()}>
            <span className="line" /><b className="fkey gold">PH</b>Executive office
          </button>
          <button ref={set('ghost')} className="sign ghost" onClick={() => ui$({ modal: 'create' })}><span className="line" /><Icon n="plus" size={14} sw={3} />Add department</button>
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
      {/* name tags for people in the open office */}
      {openDept && (
        <div className="tags">
          {[...(openDept.chief ? [{ id: 'chief', label: openDept.chief.name, k: openDept.chief.status as StatusKey }] : []), ...openDept.workers.map((w) => ({ id: w.id, label: w.id, k: w.status as StatusKey }))].map((t) => (
            <button key={t.id} ref={set('agent:' + t.id)} data-st={t.k} className={`tag${ui.agent === t.id ? ' sel' : ''}${t.id === 'chief' ? ' chief' : ''}`} onClick={() => ui$({ agent: t.id, panel: 'agent' })}>
              <Glyph k={t.k} />{t.label}
            </button>
          ))}
        </div>
      )}

      {/* top-left: HQ card or breadcrumb */}
      {wide && ui.view === 'tower' && (
        <div className="hq">
          <div className="hq-row">
            <b className="hq-n" data-t={n + 1}>{n + 1}</b>
            <span className="hq-t"><b>floors tall</b><span>Executive office and {n} departments</span></span>
          </div>
          <button className="btn primary block" onClick={() => ui$({ modal: 'create' })}><Icon n="plus" sw={3} />Add department</button>
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
          <div className="rail-disp" aria-live="polite"><span className="rail-arrow" aria-hidden="true">{ui.view === 'floor' ? '▼' : '▲'}</span>{openDept ? 'F' + (n - depts.indexOf(openDept)) : 'PH'}</div>
          <button className={`rail-b ph${ui.view === 'tower' && ui.panel === 'exec' ? ' sel' : ''}`} onClick={closeFloor} title="Executive office" aria-label="PH Executive office">PH</button>
          {depts.map((d, i) => (
            <button key={d.id} className={`rail-b${ui.floorId === d.id ? ' sel' : ''}`} onClick={() => openFloor(d.id)} title={d.name} aria-label={`F${n - i} ${d.name}`}>
              F{n - i}<i style={{ background: statusColor(deptStatus(d.state).k), color: statusColor(deptStatus(d.state).k) }} />
            </button>
          ))}
        </nav>
      )}

      {/* bottom: legend + camera */}
      {wide && (
        <div className="legend">
          <div className="legend-t">Agent states</div>
          <div className="legend-row">
            {(['running', 'idle', 'completed', 'failed', 'disconnected', 'awaiting'] as StatusKey[]).map((k) => (
              <span key={k}><Glyph k={k} />{k === 'awaiting' ? 'Awaiting config' : k[0].toUpperCase() + k.slice(1)}</span>
            ))}
          </div>
        </div>
      )}
      {wide && ui.view === 'tower' && (
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
          <Glyph k="failed" /><span><b>Can’t reach Hermes.</b> Floors show their last known state; quests can’t be created or changed.</span>
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
