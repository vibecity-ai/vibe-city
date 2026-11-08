/* The department templates (docs/briefs/01-templates.md), in hire-grid order. */
import type { Template } from '../schemas.ts';
import { tradingDesk } from './trading-desk.ts';
import { treasuryOps } from './treasury-ops.ts';
import { software } from './software.ts';
import { tokenTreasury } from './token-treasury.ts';
import { predictionDesk } from './prediction-desk.ts';
import { redTeam } from './red-team.ts';
import { blueTeam } from './blue-team.ts';

export const TEMPLATES: readonly Template[] = [software, treasuryOps, tradingDesk, tokenTreasury, predictionDesk, redTeam, blueTeam];
export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id) ?? null;
