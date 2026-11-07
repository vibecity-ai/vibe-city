/* Decisions the agents hand back to the CEO (docs/briefs/05-game-loop.md). One row each; a click opens the target. */
import type { Decision } from '@vibe-city/shared';
import { useStore } from '../store';
import { Glyph } from './kit';
import { decisionTarget } from '../data/game';

const KIND: Record<Decision['kind'], { label: string; k: 'blocked' | 'awaiting' | 'failed' }> = {
  approval: { label: 'Approve', k: 'awaiting' }, owner_confirm: { label: 'Your OK', k: 'awaiting' }, answer: { label: 'Answer', k: 'blocked' }, budget: { label: 'Budget', k: 'failed' },
};

function open(href: string) {
  const s = useStore.getState();
  const t = decisionTarget(href);
  if (t?.kind === 'quest') s.openPanel('quest', { questId: t.questId, questFrom: 'board' });
  else if (t?.kind === 'settings') { s.openFloor(t.deptId); s.openPanel('settings'); }
  else if (t?.kind === 'chat') s.ui$({ talk: { deptId: t.deptId, agentKey: t.agentKey } });
}

export function DecisionsList() {
  const game = useStore((s) => s.game);
  const depts = useStore((s) => s.depts);
  if (!game) return null;
  return (
    <section className="pane-sec">
      <h3 className="sec-t">Decisions {game.decisions.length > 0 && <span className="count bad">{game.decisions.length}</span>}</h3>
      {game.decisions.length === 0 && <p className="muted">Nothing waits for your decision. Approvals an agent asks for in chat show in that chat.</p>}
      <div className="stack">
        {game.decisions.map((d) => (
          <button key={d.id} className="attn attention" onClick={() => open(d.href)}>
            <Glyph k={KIND[d.kind].k} size={11} />
            <span className="attn-t"><b>{d.title}</b><small>{depts.find((x) => x.id === d.departmentId)?.name ?? 'A floor'}</small></span>
            <span className="btn warn small">{KIND[d.kind].label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
