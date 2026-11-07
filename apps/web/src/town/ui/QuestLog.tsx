/* CEO quest log (docs/briefs/05-game-loop.md): the quests in order with done ticks, the next one highlighted with
   its hint and the button that takes the CEO where it is done. */
import { useState } from 'react';
import type { CeoQuest } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { Icon } from './kit';
import { nextQuest, questTarget } from '../data/game';

/** The button (or note) that takes the CEO where the quest is done; the mapping lives in data/game.ts. */
function action(q: CeoQuest, busy: boolean, run: (fn: () => Promise<void>) => void) {
  const s = useStore.getState();
  const t = questTarget(q.id);
  switch (t?.kind) {
    case 'safe': return <button className="btn primary small" onClick={() => { s.openExec(); s.ui$({ execModal: 'safe' }); }}>Open the safe</button>;
    case 'hire': return <button className="btn primary small" onClick={() => s.ui$({ modal: 'create' })}>Hire a department</button>;
    case 'confirm-policy': return <button className="btn primary small" disabled={busy} onClick={() => run(async () => { useStore.setState({ game: await api.confirmPolicy() }); s.toast('Policy confirmed.'); })}>I set the policy</button>;
    case 'quest-board': return <button className="btn secondary small" onClick={() => s.openPanel('board', { composer: false, boardDept: null })}>Open the quest board</button>;
    case 'ipo': return <button className="btn primary small" disabled title="The IPO button arrives with the IPO work">Go public</button>;
    case 'note': return <span className="muted small">{t.text}</span>;
    default: return null;
  }
}

export function QuestLog() {
  const game = useStore((s) => s.game);
  const [busy, setBusy] = useState(false);
  if (!game) return null;
  const next = nextQuest(game);
  const run = (fn: () => Promise<void>) => { setBusy(true); fn().catch((e) => useStore.getState().toast(e instanceof ApiError ? e.message : 'That did not work.', 'bad')).finally(() => setBusy(false)); };
  const n = game.quests.filter((q) => q.done).length;
  return (
    <section className="pane-sec">
      <h3 className="sec-t">Quest log <span className="muted small">{n} of {game.quests.length}</span></h3>
      <ol className="qlog">
        {game.quests.map((q) => (
          <li key={q.id} className={`qlog-i${q.done ? ' done' : ''}${q === next ? ' next' : ''}`}>
            <span className="qlog-tick" aria-hidden="true">{q.done ? <Icon n="sparkle" size={12} /> : null}</span>
            <span className="qlog-body">
              <b>{q.title}</b><span className="sr">{q.done ? ' (done)' : q === next ? ' (next)' : ''}</span>
              {q.unlocks && <small className="qlog-unl">Unlocks {q.unlocks}</small>}
              {q === next && <><span className="qlog-hint">{q.hint}</span><span className="qlog-act">{action(q, busy, run)}</span></>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
