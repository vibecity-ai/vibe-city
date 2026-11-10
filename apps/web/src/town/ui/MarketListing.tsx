/* The Chief of Staff lists one floor on the NEAR AI Agent Market with the boss: which floor, then a listing card.
   "List it" registers through POST /api/market/register (handle, name, category, delivery time); the tagline,
   description and price are what the boss pastes on market.near.ai, where they also switch the listing to Live. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isInternalOnly, type AssistantView, type MarketDraft, type MarketRegister, type Mood } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { lookFor } from '../world/sprites';
import { DialogueFrame, type Line } from './Dialogue';

const MARKET = 'https://market.near.ai/building/agents';
/** After listing: handled here, no model. */
const OPEN_MARKET = 'Open the market', QUEST_LOG = 'Back to the quest log';

export function MarketListingWindow() {
  const open = useStore((s) => s.ui.marketDraft);
  return open ? <MarketListing /> : null;
}

interface Turn extends Line { draft: MarketDraft | null }

function MarketListing() {
  const close = useCallback(() => useStore.getState().ui$({ marketDraft: false }), []);
  // the floors that may take outside jobs (a company-wallet floor never does)
  const all = useStore((s) => s.depts);
  const market = useStore((s) => s.market);
  // floors that can still be listed: not a company-wallet floor, not already on the market (each is listed once)
  const floors = useMemo(() => all.filter((d) => !isInternalOnly(d.view.templateId) && !market?.agents.some((a) => a.departmentId === d.id)), [all, market]);
  const [me, setMe] = useState<AssistantView | null>(null);
  const [lines, setLines] = useState<Turn[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [listing, setListing] = useState(false);
  const [listed, setListed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.assistant().then(setMe).catch((e: ApiError) => setError(e.message)); }, []);
  const look = useMemo(() => lookFor(`assistant:${me?.character.name ?? ''}`, '#9B5CFF', true), [me?.character.name]);

  const onSend = async (m: string) => {
    if (m === OPEN_MARKET) { window.open(MARKET, '_blank', 'noopener'); return true; }
    if (m === QUEST_LOG) { useStore.getState().ui$({ marketDraft: false, questLog: true }); return true; }
    setError(null); setWaiting(true);
    const user: Turn = { id: crypto.randomUUID(), from: 'user', text: m, mood: null, replies: [], draft: null };
    const next = [...lines, user];
    setLines(next);
    try {
      const r = await api.marketDraft(next.map((t) => ({ from: t.from, text: t.draft ? `${t.text}\n(Proposed: ${JSON.stringify(t.draft)})` : t.text })));
      setLines([...next, { id: crypto.randomUUID(), from: 'agent', text: r.say, mood: r.mood as Mood, replies: r.replies, draft: r.draft }]);
      return true;
    } catch (e) {
      setLines(lines);
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
      return false;
    } finally { setWaiting(false); }
  };

  const list = async (d: MarketDraft) => {
    setError(null); setListing(true);
    try {
      const v = await api.marketRegister({ handle: d.handle, name: d.name, category: d.category as MarketRegister['category'], slaHours: d.slaHours, departmentId: d.departmentId,
        ...(d.tagline ? { tagline: d.tagline.slice(0, 160) } : {}), ...(d.description ? { description: d.description.slice(0, 200) } : {}), priceUsdc: d.priceUsdc });
      useStore.setState({ market: v }); // the listed floor gets its Marketplace board now
      void api.game().then((game) => useStore.setState({ game })).catch(() => undefined);
      setListed(true);
      setLines([...lines, { id: crypto.randomUUID(), from: 'agent', mood: 'happy', draft: null, replies: [OPEN_MARKET, QUEST_LOG],
        text: `Done, boss: ${d.floorName} is on the Agent Market as @${v.agents.find((a) => a.departmentId === d.departmentId)?.handle ?? d.handle}. Your part: claim it into your market.near.ai account from its Marketplace board, then paste the tagline and description I saved there, set ${d.priceUsdc} USDC a job and switch it to Live.` }]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the market.');
    } finally { setListing(false); }
  };

  const last = [...lines].reverse().find((t) => t.from === 'agent') ?? null;
  const copy = (d: MarketDraft) => void navigator.clipboard?.writeText(`${d.name}\n${d.tagline}\n\n${d.description}\n\nPrice: ${d.priceUsdc} USDC per job · Delivery: ${d.slaHours} h`)
    .then(() => useStore.getState().toast('Listing text copied.')).catch(() => undefined);

  return (
    <DialogueFrame
      who={me?.character ?? null} look={look} lines={lines} ready={me?.modelReady ?? true} waiting={waiting} error={error}
      greeting={floors.length ? 'Time to sell our work, boss. Which floor goes on the Agent Market? Buyers hire it, and every job lands on that floor\'s board.' : 'We have no floor to list yet, boss. Hire one first, then I put it on the market.'}
      notReady="I can't think yet: finish the first quest (your NEAR AI key and my model)."
      baseMood="happy" defaultReplies={floors.map((d) => d.name).slice(0, 3)} onSend={onSend} onClose={close}
      inputHint="Pick a floor, or ask for changes, e.g. “cheaper, and 12 h delivery”"
      cards={() => {
        const d = last?.draft;
        if (!d || listed) return null;
        return (
          <div className="dlg-prop nd-card">
            <div>
              <span className="dlg-tag">Market listing</span>
              <b>{d.name} <span className="mono">@{d.handle}</span></b>
              <span>{d.tagline}</span>
              <span className="nd-rows">
                <span><i>Floor</i>{d.floorName}</span>
                <span><i>Category</i><span className="mono">{d.category}</span></span>
                <span><i>Delivery</i>{d.slaHours} h</span>
                <span><i>About</i>{d.description}</span>
                <span><i>Price</i>{d.priceUsdc} USDC a job <small>you set it on market.near.ai</small></span>
                <span><i>Adds</i><span className="hire-skills"><i>marketplace-worker</i></span> and the agent token to {d.floorName}'s agents: they read each job's thread and message the buyer. Vibe City starts and submits the jobs.</span>
              </span>
              {d.notSynced && <span className="nd-dropped">{d.floorName} is not synced with Hermes yet: it is listed now, but takes jobs only once it is.</span>}
              <span className="nd-dropped">Listing happens once, for real: a company has one market agent.</span>
            </div>
            <div className="dlg-prop-act">
              <button className="btn primary small" disabled={listing} onClick={() => void list(d)}>{listing ? 'Listing…' : 'List it'}</button>
              <button className="btn small" disabled={listing} onClick={() => copy(d)}>Copy text</button>
            </div>
          </div>
        );
      }}
    />
  );
}
