/* The Chief of Staff lists one floor on the NEAR AI Agent Market with the boss: which floor, then the listing as a
   newspaper front page. "Publish" takes the boss to that floor and registers through POST /api/market/register (handle, name, category, delivery time); the tagline,
   description and price are what the boss pastes on market.near.ai, where they also switch the listing to Live. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isInternalOnly, type AssistantView, type MarketDraft, type MarketRegister, type Mood } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { COS_LOOK } from '../world/sprites';
import { STATION_BUILD_MS } from '../data/floor';
import { DialogueFrame, type Line } from './Dialogue';

const MARKET = 'https://market.near.ai/building/agents';
/** After listing: handled here, no model. */
const OPEN_MARKET = 'Open the market', QUEST_LOG = 'Back to the quest log';


/** A floor's market listing as a front page: what buyers will read. `onCopy` adds a copy button to each pasted part. */
export function ListingPaper({ name, handle, href, badges, tagline, description, priceUsdc, category, slaHours, floorName, onCopy, watermark, children }: {
  name: string; handle: string; tagline?: string | null; description?: string | null; priceUsdc?: string | null; category?: string | null; slaHours?: number | null;
  /** The public page of a listed agent (the handle links to it), and its status chips (verified, live). */
  href?: string; badges?: ReactNode;
  floorName?: string; onCopy?: (label: string, text: string) => void; children?: ReactNode;
  /** Stamped across the page, e.g. DRAFT while the listing is not live. */
  watermark?: string;
}) {
  const copyBtn = (label: string, text: string) => onCopy && <button type="button" className="paper-copy" onClick={() => onCopy(label, text)}>Copy</button>;
  return (
    <article className="paper" aria-label={`Market listing: ${name}${watermark ? ` (${watermark.toLowerCase()})` : ''}`}>
      {watermark && <span className="paper-wm" aria-hidden="true">{watermark}</span>}
      <header className="paper-mast"><span>{new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span><b>The Agent Market Gazette</b><span>market.near.ai</span></header>
      <p className="paper-kicker"><span>{floorName ? `From the ${floorName} floor` : 'Agents for hire'}{category ? ` · ${category.replace(/_/g, ' ')}` : ''}</span>{badges && <span className="paper-badges">{badges}</span>}</p>
      <h3 className="paper-head">{name} {href ? <a href={href} target="_blank" rel="noreferrer">@{handle}</a> : <span>@{handle}</span>}</h3>
      {tagline && <p className="paper-deck">{tagline} {copyBtn('Tagline', tagline)}</p>}
      {description && <p className="paper-body">{description} {copyBtn('Description', description)}</p>}
      {(priceUsdc || slaHours) && <dl className="paper-facts">
        {priceUsdc && <div><dt>Price</dt><dd>{priceUsdc} USDC a job</dd></div>}
        {slaHours && <div><dt>Delivered in</dt><dd>{slaHours} h</dd></div>}
      </dl>}
      {children}
    </article>
  );
}

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
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.assistant().then(setMe).catch((e: ApiError) => setError(e.message)); }, []);
  const look = COS_LOOK;

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

  /** Publishing leaves the office: the boss stands on the floor while the market answers, sees its Marketplace board
      go up, and the board opens on the claim step. A refusal (a taken handle…) comes back here to try again. */
  const list = (d: MarketDraft) => {
    const s = useStore.getState();
    s.ui$({ marketDraft: false }); s.openFloor(d.departmentId);
    s.toast(`Sending ${d.floorName}'s listing to market.near.ai…`);
    const onFloor = () => { const u = useStore.getState().ui; return u.view === 'floor' && u.floorId === d.departmentId; };
    void (async () => {
      try {
        // the pause lets the floor open first, so the board is seen going up
        const [v] = await Promise.all([api.marketRegister({ handle: d.handle, name: d.name, category: d.category as MarketRegister['category'], slaHours: d.slaHours, departmentId: d.departmentId,
          ...(d.tagline ? { tagline: d.tagline.slice(0, 160) } : {}), ...(d.description ? { description: d.description.slice(0, 200) } : {}), priceUsdc: d.priceUsdc }), new Promise((r) => setTimeout(r, 1200))]);
        useStore.setState({ market: v }); // the listed floor gets its Marketplace board now: the city builds it
        void api.game().then((game) => useStore.setState({ game })).catch(() => undefined);
        s.toast(`${d.floorName} is on the Agent Market as @${v.agents.find((a) => a.departmentId === d.departmentId)?.handle ?? d.handle}. Claim it from its Marketplace board.`);
        setTimeout(() => { if (onFloor()) useStore.getState().ui$({ floorSheet: 'station' }); }, STATION_BUILD_MS + 300);
      } catch (e) {
        s.toast(`The listing did not go through: ${e instanceof ApiError ? e.message : 'could not reach the market'}`, 'bad');
        if (onFloor()) { s.openExec(); s.ui$({ marketDraft: true }); }
      }
    })();
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
        if (!d) return null;
        return (
          <div className="dlg-prop">
            <ListingPaper name={d.name} handle={d.handle} tagline={d.tagline} description={d.description} priceUsdc={d.priceUsdc} category={d.category} slaHours={d.slaHours} floorName={d.floorName}>
              <p className="paper-fine">Publishing gives {d.floorName}'s agents the agent token and the marketplace-worker skill: they read each job's thread and message the buyer; Vibe City starts and submits the jobs. You set the price and go Live on market.near.ai. A floor is listed once, for real.</p>
              {d.notSynced && <p className="paper-fine">{d.floorName} is not synced with Hermes yet: it is listed now, but takes jobs only once it is.</p>}
            </ListingPaper>
            <div className="dlg-prop-act">
              <button className="btn primary small" onClick={() => list(d)}>Publish</button>
              <button className="btn small" onClick={() => copy(d)}>Copy text</button>
            </div>
          </div>
        );
      }}
    />
  );
}
