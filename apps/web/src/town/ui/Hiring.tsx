/* AR: scouting and hiring (feature spec 7.1). The phone rings when AR's rules fire; answering opens the Chief of Staff's
   dialogue (NewDept.tsx) with the reason, where the talk ends in a brief and confirming it puts the three candidates that
   fit it best right in that dialogue. Every number on a card comes from the backend: loadouts are built from what
   Hermes really offers, priced at NEAR AI's list prices. */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Candidate, HiringRequestView } from '@vibe-city/shared';
import { useStore } from '../store';
import { api } from '../../api';
import { COS_LOOK, lookFor } from '../world/sprites';
import { PortraitCanvas, blip, readMuted } from './Dialogue';
import { Icon } from './kit';
import { ModelName } from './ModelBadge';

const POLL_MS = 15_000;
const TIER = ['', 'Small model', 'Balanced model', 'Large model'];

const set = (h: HiringRequestView | null) => useStore.getState().hiring$(h);

const candLook = (c: Candidate) => lookFor(c.character.agentKey, c.character.color, false);

/** Keeps the open hiring request fresh: a slow poll (AR's rules run on the backend). */
function useHiringPoll() {
  useEffect(() => {
    let live = true;
    const tick = () => api.hiringCurrent().then((r) => { if (live) set(r); }).catch(() => undefined);
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => { live = false; window.clearInterval(id); };
  }, []);
}

/** The phone slot in the top bar (TopBar renders it): calls sit there, never over the game. */
function useHudSlot() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => { setEl(document.getElementById('hud-phone')); }, []);
  return el;
}

/** Cents (budgets and estimates are kept in cents) as dollars. */
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function HiringLayer() {
  useHiringPoll();
  const h = useStore((s) => s.hiring);
  const slot = useHudSlot();
  return slot && h && h.state === 'ringing' ? createPortal(<IncomingCall h={h} />, slot) : null;
}

/** The Chief of Staff calling: a small phone in the top bar that rings three times and then waits quietly. It never
    takes the keyboard and never covers the game; the reason shows on hover or focus. */
function IncomingCall({ h }: { h: HiringRequestView }) {
  const look = COS_LOOK;
  useEffect(() => {
    if (readMuted()) return;
    let n = 0;
    const ring = () => { blip(880, 0.03, 0.08); window.setTimeout(() => blip(660, 0.03, 0.08), 140); if (++n >= 3) window.clearInterval(id); };
    const id = window.setInterval(ring, 2200); ring();
    return () => window.clearInterval(id);
  }, []);
  // picking up ends the ring: the talk is the Chief of Staff's chat, opened on the reason for the call
  const answer = () => { void api.hiringDecline(h.id).catch(() => undefined); set(null); useStore.getState().ui$({ newDept: true, cosCall: h.trigger.reason }); };
  const decline = async () => { try { set(await api.hiringDecline(h.id)); } catch { /* ignore */ } set(null); };
  return (
    <div className="ring" role="status" aria-labelledby="ring-t" aria-describedby="ring-d">
      <div className="ring-face"><PortraitCanvas look={look} mood="worried" talking={false} size={96} gag="clipboard" className="ring-portrait" /></div>
      <div className="ring-body">
        <span className="ring-tag"><Icon n="phone" size={11} /> Calling</span>
        <b id="ring-t">{h.ar.name}</b>
      </div>
      <button className="ring-yes" onClick={answer}>Answer</button>
      <button className="ring-no" onClick={() => void decline()} aria-label="Decline the call" title="Decline"><Icon n="x" size={13} /></button>
      <p className="ring-why" id="ring-d">{h.trigger.reason}</p>
    </div>
  );
}

/** The candidates for a confirmed brief, as cards with a Hire button (the Chief of Staff's dialogue shows them). */
export function CandidateCards({ h, busy, onHire }: { h: HiringRequestView; busy: boolean; onHire: (c: Candidate) => void }) {
  return (
    <div className="hire-grid">
      {h.candidates.map((c) => {
        const over = c.costPerDay > (h.brief?.budgetPerDay ?? Infinity);
        return (
          <article key={c.id} className="cand" style={{ ['--who' as string]: c.character.color }}>
            <div className="cand-top">
              <div className="cand-face"><PortraitCanvas look={candLook(c)} mood="happy" talking={false} size={96} className="cand-portrait" /></div>
              <div className="cand-id"><b>{c.character.name}</b><span>{c.character.title}</span><span className="cand-traits">{c.character.traits.join(' · ')}</span></div>
            </div>
            <dl className="cand-stats">
              <dt>Model</dt><dd>{c.loadout.model ? <ModelName id={c.loadout.model.id} /> : <span className="mono">floor default</span>} <small>{TIER[c.tier]}</small></dd>
              <dt>Skills</dt><dd>{c.loadout.skills.length ? <span className="hire-skills">{c.loadout.skills.map((s) => <i key={s}>{s}</i>)}</span> : <small className="muted">none</small>}</dd>
              <dt>Cost</dt><dd className={over ? 'bad' : ''}>~{dollars(c.costPerDay)} a day <small title="One busy agent: 1M input + 100k output tokens a day at the model's NEAR AI list price">estimate{over ? ', over budget' : ''}</small></dd>
              <dt>Fit</dt><dd><span className="fit" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.fitScore} aria-label="Fit score"><i style={{ width: `${c.fitScore}%` }} /></span> <b>{c.fitScore}</b></dd>
            </dl>
            <p className="cand-note"><span>Chief of Staff:</span> {c.note}</p>
            <div className="cand-act">
              <button className="btn small primary" disabled={busy} onClick={() => onHire(c)}>Hire</button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
