/* AR: scouting and hiring (feature spec 7.1). The phone rings when AR's rules fire (or you call AR); the intake is a
   chat with AR's head in the dialogue window that ends in a brief; confirming it puts four candidates (two serious,
   two joke) right in that dialogue, where you can ask the Chief of Staff about them and their models, then hire one. Every number on a card comes from
   the backend: loadouts are built from what Hermes really offers, and the joke candidates' numbers are honestly bad. */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Candidate, HiringRequestView } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { COS_LOOK, lookFor } from '../world/sprites';
import type { Gag } from '../world/portrait';
import { DialogueFrame, PortraitCanvas, blip, readMuted, type Line } from './Dialogue';
import { Icon } from './kit';
import { ModelName } from './ModelBadge';
import { loadDeptInfo, refreshDept } from '../data/live';

const POLL_MS = 15_000;
const TIER = ['', 'Small model', 'Balanced model', 'Large model'];

const set = (h: HiringRequestView | null) => useStore.getState().hiring$(h);
const call = (c: ReturnType<typeof useStore.getState>['ui']['call']) => useStore.getState().ui$({ call: c });
/** The Chief of Staff's face: the same look as in the floor-drafting dialogue (the assistant and AR are one person). */

const candLook = (c: Candidate) => lookFor(c.character.agentKey, c.character.color, false);

/** Keeps the open hiring request fresh: a slow poll (AR's rules run on the backend). */
function useHiringPoll() {
  useEffect(() => {
    let live = true;
    // Keep a finished request on screen while its call is still open (the backend no longer lists it as current).
    const tick = () => api.hiringCurrent().then((r) => {
      if (!live) return;
      const s = useStore.getState();
      if (!r && s.hiring && s.ui.call?.reqId === s.hiring.id) return;
      set(r);
    }).catch(() => undefined);
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
  const c = useStore((s) => s.ui.call);
  const slot = useHudSlot();
  return (
    <>
      {slot && h && !c && h.state === 'ringing' && createPortal(<IncomingCall h={h} />, slot)}
      {c && <ArDialogue key={c.reqId} reqId={c.reqId} />}
    </>
  );
}

/** Opens a call to AR (Exec Office button, floor panel). Reuses the open request. */
export async function callAr(departmentId?: string) {
  try {
    const h = await api.hiringStart(departmentId);
    set(h);
    call({ reqId: h.id });
  } catch (e) { useStore.getState().toast(e instanceof ApiError ? e.message : 'Could not reach the Chief of Staff.', 'bad'); }
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
  const answer = async () => { try { set(await api.hiringAnswer(h.id)); call({ reqId: h.id }); } catch { /* the poll will retry */ } };
  const decline = async () => { try { set(await api.hiringDecline(h.id)); } catch { /* ignore */ } set(null); };
  return (
    <div className="ring" role="status" aria-labelledby="ring-t" aria-describedby="ring-d">
      <div className="ring-face"><PortraitCanvas look={look} mood="worried" talking={false} size={96} gag="clipboard" className="ring-portrait" /></div>
      <div className="ring-body">
        <span className="ring-tag"><Icon n="phone" size={11} /> Calling</span>
        <b id="ring-t">{h.ar.name}</b>
      </div>
      <button className="ring-yes" onClick={() => void answer()}>Answer</button>
      <button className="ring-no" onClick={() => void decline()} aria-label="Decline the call" title="Decline"><Icon n="x" size={13} /></button>
      <p className="ring-why" id="ring-d">{h.trigger.reason}</p>
    </div>
  );
}

/* ---------- the intake call with AR's head ---------- */

function ArDialogue({ reqId }: { reqId: string }) {
  const h = useStore((s) => (s.hiring?.id === reqId ? s.hiring : null));
  const depts = useStore((s) => s.depts);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [concern, setConcern] = useState<string | null>(null);
  const close = useCallback(() => call(null), []);
  useEffect(() => { api.hiring(reqId).then(set).catch((e: ApiError) => setError(e.message)); }, [reqId]);
  const look = COS_LOOK;
  if (!h) return null;

  const intake = h.state === 'intake' || h.state === 'ringing';
  const talking = intake || h.state === 'shortlist';
  const trigDept = h.trigger.departmentId ? depts.find((d) => d.id === h.trigger.departmentId) : null;
  const hired = h.candidates.find((c) => c.id === h.hiredCandidateId);
  const greeting = h.state === 'shortlist' ? `Back with ${h.candidates.length} candidates for ${h.brief?.departmentName}. Two are solid. The other two... you'll see.`
    : h.state === 'hired' && hired && h.applied ? `Done. ${hired.character.name} joins ${h.brief?.departmentName}. ${hired.serious ? 'Good call.' : "I've noted my concerns in the file."}`
    : h.state === 'closed' ? 'Call ended. Ring me when you need someone.'
    : h.trigger.kind === 'manual' ? `Who are we hiring, boss? Tell me what the new person should be good at.`
    : `Boss, ${h.trigger.reason} Want me to find someone?`;
  const lines: Line[] = talking ? [...h.messages, ...(pending ? [{ id: 'pending', from: 'user' as const, text: pending, mood: null, replies: [] }] : [])] : [];
  const defaults = trigDept ? [`Yes, find someone for ${trigDept.name}`, 'What would they need?', 'Not now']
    : depts.slice(0, 3).map((d) => `We need help on ${d.name}`);

  const onSend = async (m: string) => {
    setError(null); setWaiting(true); setPending(m);
    try { set(await api.hiringChat(h.id, m)); return true; }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong.'); return false; }
    finally { setWaiting(false); setPending(null); }
  };
  const hire = async (c: Candidate) => {
    // a joke candidate takes a second click: the Chief of Staff's concerns are on the card
    if (!c.serious && concern !== c.id) { setConcern(c.id); return; }
    setWaiting(true);
    try {
      set(await api.hiringOffer(h.id, c.id, !c.serious));
      // The floor re-provisions in the background: refresh it now and once more when that is likely done.
      const dep = h.brief!.departmentId, again = () => { void refreshDept(dep); void loadDeptInfo(dep); };
      again(); window.setTimeout(again, 4000);
    } catch (e) { useStore.getState().toast(e instanceof ApiError ? e.message : 'Something went wrong.', 'bad'); }
    finally { setWaiting(false); setConcern(null); }
  };
  const scout = async () => {
    setWaiting(true); setError(null);
    try { set(await api.hiringBrief(h.id)); } catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong.'); }
    finally { setWaiting(false); }
  };

  return (
    <DialogueFrame
      who={h.ar} look={look} gag="clipboard" lines={lines} ready={talking ? h.modelReady : true} waiting={waiting} error={error}
      greeting={greeting} baseMood={h.state === 'shortlist' ? 'smug' : h.trigger.kind === 'manual' ? 'neutral' : 'worried'}
      defaultReplies={intake ? defaults : h.state === 'shortlist' ? ['Which one is cheapest?', 'Which model is best for this?'] : []}
      onSend={onSend} onClose={close} hideInput={!talking}
      inputHint={intake ? 'What should the new hire be good at?' : 'Ask about the candidates or their models…'}
      cards={(last) => {
        const brief = intake ? h.messages.findLast((m) => m.from === 'agent' && m.brief)?.brief ?? null : null;
        if (intake && brief && last && h.messages.at(-1)?.brief) return (
          <div className="dlg-prop">
            <div>
              <span className="dlg-tag">Hire brief</span>
              <b>{brief.focus}</b>
              <span>{brief.departmentName} · budget {dollars(brief.budgetPerDay)} a day{brief.notes ? ` · ${brief.notes}` : ''}</span>
              {brief.skills.length > 0 && <span className="hire-skills">{brief.skills.map((s) => <i key={s}>{s}</i>)}</span>}
            </div>
            <div className="dlg-prop-act">
              <button className="btn primary small" onClick={() => void scout()}>Go find candidates</button>
            </div>
          </div>
        );
        if (h.state === 'shortlist' && h.brief) return (
          <div className="hire-grid">
            {h.candidates.map((c) => {
              const over = c.costPerDay > h.brief!.budgetPerDay;
              return (
                <article key={c.id} className={`cand${c.serious ? '' : ' joke'}`} style={{ ['--who' as string]: c.character.color }}>
                  <div className="cand-top">
                    <div className="cand-face"><PortraitCanvas look={candLook(c)} mood={c.serious ? 'happy' : 'smug'} talking={false} size={96} gag={(c.gag as Gag | null) ?? null} className="cand-portrait" /></div>
                    <div className="cand-id"><b>{c.character.name}</b><span>{c.character.title}</span><span className="cand-traits">{c.character.traits.join(' · ')}</span></div>
                  </div>
                  <dl className="cand-stats">
                    <dt>Model</dt><dd>{c.loadout.model ? <ModelName id={c.loadout.model.id} /> : <span className="mono">floor default</span>} <small>{TIER[c.tier]}</small></dd>
                    <dt>Skills</dt><dd>{c.loadout.skills.length ? <span className="hire-skills">{c.loadout.skills.map((s) => <i key={s}>{s}</i>)}</span> : <small className="muted">none</small>}</dd>
                    <dt>Cost</dt><dd className={over ? 'bad' : ''}>~{dollars(c.costPerDay)} a day <small title="One busy agent: 1M input + 100k output tokens a day at the model's NEAR AI price">estimate{over ? ', over budget' : ''}</small></dd>
                    <dt>Fit</dt><dd><span className="fit" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.fitScore} aria-label="Fit score"><i style={{ width: `${c.fitScore}%` }} /></span> <b>{c.fitScore}</b></dd>
                  </dl>
                  <p className={`cand-note${concern === c.id ? ' bad' : ''}`}><span>Chief of Staff:</span> {c.note}{concern === c.id ? ' Boss, are you sure?' : ''}</p>
                  <div className="cand-act">
                    <button className={`btn small${c.serious ? ' primary' : concern === c.id ? ' warn' : ''}`} disabled={waiting} onClick={() => void hire(c)}>{concern === c.id ? 'Hire anyway' : 'Hire'}</button>
                  </div>
                </article>
              );
            })}
          </div>
        );
        if (h.state === 'hired' && h.applied) return (
          <div className="dlg-prop-act">
            <button className="btn primary small" onClick={() => { close(); useStore.getState().openFloor(h.applied!.departmentId); }}>Go to {h.brief?.departmentName}</button>
          </div>
        );
        return null;
      }}
    />
  );
}
