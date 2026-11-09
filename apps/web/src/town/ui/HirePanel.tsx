/* Hire a department from a template (docs/briefs/01-templates.md): the first step of the create form. Picking a
   template pre-fills the form (name, purpose, capabilities, the team) so the CEO can still change anything. */
import { BASE, TOOL_INFO } from '../data/floor';
import { SkillBadges } from './Skills';
import { useEffect, useState } from 'react';
import type { TemplateList } from '@vibe-city/shared';
import { api, ApiError } from '../../api';
import { Icon } from './kit';

export type HireTemplate = TemplateList[number];

/** "Unlocks after <quest>": the game loop (brief 05) names the quest; until then the quest id is shown. */
export function HireGrid({ onPick, onBlank, onAssistant, questTitle }: {
  onPick: (t: HireTemplate) => void; onBlank: () => void; onAssistant: () => void; questTitle?: (id: string) => string | null;
}) {
  const [list, setList] = useState<TemplateList | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.templates().then(setList).catch((e: ApiError) => setError(e.message)); }, []);
  return (
    <div className="hire-pick">
      <p className="sub">Pick a team to hire. Each template brings its agents, their jobs and what they may use; you can change anything on the next steps.</p>
      {error && <p className="err-t" role="alert">{error}</p>}
      {!list && !error && <p className="muted small" role="status">Loading templates…</p>}
      {list && (
        <ul className="tpl-grid">
          {list.map((t) => {
            const quest = t.unlocks ? (questTitle?.(t.unlocks) ?? t.unlocks) : null;
            return (
              <li key={t.id}>
                <button type="button" className={`tpl-card${t.locked ? ' locked' : ''}`} disabled={t.locked} onClick={() => onPick(t)} aria-describedby={`tpl-${t.id}`}>
                  <span className="tpl-top"><b>{t.name}</b>
                    {t.locked ? <span className="tpl-lock"><Icon n="lock" size={12} />Unlocks after {quest}</span> : t.wallet === 'company' && <span className="tpl-chip" title="Spends from the shared company wallet">Wallet</span>}</span>
                  <span id={`tpl-${t.id}`} className="tpl-seats">{t.seats.map((s) => s.title).join(' · ')}</span>
                  <span className="tpl-row"><i>Tools</i>{t.inventory.allowedToolsets.filter((x) => !BASE.includes(x)).map((x) => TOOL_INFO[x]?.label ?? x).join(', ')}</span>
                  {t.inventory.allowedSkillIds.length > 0 && <span className="tpl-row"><i>Skills</i><SkillBadges names={t.inventory.allowedSkillIds} max={9} size={11} /></span>}
                  <span className="tpl-row"><i>Budget</i>{t.dailyBudgetCredits} credits a day{t.loop ? ' · runs on a schedule' : ''}</span>
                  {!t.locked && quest && <span className="tpl-row"><i>Unlocked by</i>{quest}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="muted small hire-alt">Something else? <button type="button" className="link" onClick={onBlank}>Start from a blank floor</button> or <button type="button" className="link" onClick={onAssistant}>describe it to the assistant</button>.</p>
    </div>
  );
}
