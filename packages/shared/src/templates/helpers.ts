/* Building blocks for the department templates (docs/briefs/01-templates.md). Templates are configuration only. */
import { InventorySchema, type Template, type TemplateSeat, type Toolset } from '../schemas.ts';

const ABLITERATED = { provider: 'near-ai', id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated' };

export const seat = (title: string, opts: { skills?: string[]; toolsets?: Toolset[]; abliterated?: boolean } = {}): TemplateSeat => ({
  title, model: opts.abliterated ? ABLITERATED : null, skills: opts.skills ?? [], toolsets: opts.toolsets ?? [],
});

/** A template: the department inventory carries the toolsets of every seat and the daily budget. */
export function template(t: Omit<Template, 'inventory' | 'hidden'> & { toolsets: Toolset[]; hidden?: boolean }): Template {
  const { toolsets, ...rest } = t;
  const all = [...new Set([...toolsets, ...t.seats.flatMap((s) => s.toolsets as Toolset[])])];
  return {
    ...rest,
    hidden: t.hidden ?? false,
    inventory: InventorySchema.parse({ allowedToolsets: all, allowedSkillIds: [...new Set([...t.skills, ...t.seats.flatMap((s) => s.skills)])], limits: { dailyBudgetCredits: t.dailyBudgetCredits } }),
  };
}

/** The purpose text every agent of the floor reads: the job, then who does what (the lead hands parts out by title). */
export const purpose = (job: string, seats: TemplateSeat[], rules: string[] = []) =>
  [job, 'Team: ' + seats.map((s, i) => `${s.title}${i === 0 ? ' (lead)' : ''}`).join(', ') + '.', ...rules].join(' ');
