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
  const free = list?.filter((t) => !t.locked && !t.hired).length ?? 0;
  return (
    <div className="hire-pick">
      <p className="sub">Pick a ready-made team: each brings its agents, their jobs and what they may use, and you can change anything on the next steps. Every template is one per company.</p>
      {error && <p className="err-t" role="alert">{error}</p>}
      {!list && !error && <p className="muted small" role="status">Loading templates…</p>}
      {list && <>
        <h3 className="tpl-h">Templates <span>{free} of {list.length} available</span></h3>
        <ul className="tpl-grid">
          {list.map((t) => {
            const quest = t.unlocks ? (questTitle?.(t.unlocks) ?? t.unlocks) : null;
            const tools = t.inventory.allowedToolsets.filter((x) => !BASE.includes(x)).map((x) => TOOL_INFO[x]?.label ?? x);
            const state = t.locked ? 'locked' : t.hired ? 'hired' : 'open';
            return (
              <li key={t.id}>
                <button type="button" className={`tpl-card ${state}`} disabled={state !== 'open'} onClick={() => onPick(t)} aria-describedby={`tpl-${t.id}`}>
                  <span className="tpl-top">
                    <b>{t.name}</b>
                    {t.wallet === 'company' && <span className="tpl-chip" title="Spends from the shared company wallet">Wallet</span>}
                    {t.loop && <span className="tpl-chip loop" title="Hiring it adds a schedule (off until you turn it on)">Schedule</span>}
                  </span>
                  <span id={`tpl-${t.id}`} className="tpl-job">{t.purpose.split(' Team: ')[0]}</span>
                  <span className="tpl-team" aria-label={`Team of ${t.seats.length}`}>
                    {t.seats.map((x, i) => <i key={x.title} className={i === 0 ? 'lead' : ''} title={i === 0 ? 'Lead' : undefined}>{x.title}</i>)}
                  </span>
                  {tools.length > 0 && <span className="tpl-row"><i>Tools</i>{tools.join(', ')}</span>}
                  {t.inventory.allowedSkillIds.length > 0 && <span className="tpl-row"><i>Skills</i><SkillBadges names={t.inventory.allowedSkillIds} max={9} size={11} /></span>}
                  <span className="tpl-foot">
                    {state === 'locked' ? <><Icon n="lock" size={13} />Unlocks after {quest}</>
                      : state === 'hired' ? <><Icon n="check" size={13} sw={3} />On your tower</>
                      : <>Hire this team<Icon n="chev" size={14} sw={3} /></>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </>}
      <h3 className="tpl-h">Build your own</h3>
      <div className="tpl-own">
        <button type="button" className="tpl-card own cos" onClick={onAssistant}>
          <span className="tpl-top"><Icon n="sparkle" size={16} /><b>Draft with your Chief of Staff</b></span>
          <span className="tpl-job">Describe what you need; they design a custom floor from what Hermes has installed.</span>
          <span className="tpl-foot">Start the chat<Icon n="chev" size={14} sw={3} /></span>
        </button>
        <button type="button" className="tpl-card own" onClick={onBlank}>
          <span className="tpl-top"><Icon n="plus" size={16} sw={3} /><b>Blank floor</b></span>
          <span className="tpl-job">Name it, then choose its tools, skills, model and team yourself.</span>
          <span className="tpl-foot">Start blank<Icon n="chev" size={14} sw={3} /></span>
        </button>
      </div>
    </div>
  );
}
