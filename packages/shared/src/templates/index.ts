/* The department templates (docs/briefs/01-templates.md), in hire-grid order. */
import type { Template } from '../schemas.ts';
import { tradingDesk } from './trading-desk.ts';
import { treasuryOps } from './treasury-ops.ts';
import { predictionDesk } from './prediction-desk.ts';
import { chiefOfStaff } from './chief-of-staff.ts';
import { contractStudio } from './contract-studio.ts';
import { auditGuild } from './audit-guild.ts';
import { thesisLab } from './thesis-lab.ts';

export { TEMPLATE_BASE_TOOLSETS } from './helpers.ts';

export const TEMPLATES: readonly Template[] = [contractStudio, auditGuild, thesisLab, treasuryOps, tradingDesk, predictionDesk, chiefOfStaff];
/** The hidden template every company's Chief of Staff department is made from. */
export const CHIEF_OF_STAFF = chiefOfStaff.id;
export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id) ?? null;
/** Floors that spend from the company wallet are internal: never listed on the market, never given work by the listed floor. */
export const isInternalOnly = (templateId?: string | null) => !!templateId && templateById(templateId)?.wallet === 'company';
