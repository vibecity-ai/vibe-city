/* The department templates (docs/briefs/01-templates.md), in hire-grid order. */
import type { Template } from '../schemas.ts';
import { tradingDesk } from './trading-desk.ts';
import { treasuryOps } from './treasury-ops.ts';
import { predictionDesk } from './prediction-desk.ts';
import { marketplaceAgency } from './marketplace-agency.ts';

export { TEMPLATE_BASE_TOOLSETS } from './helpers.ts';

export const TEMPLATES: readonly Template[] = [marketplaceAgency, treasuryOps, tradingDesk, predictionDesk];
export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id) ?? null;
