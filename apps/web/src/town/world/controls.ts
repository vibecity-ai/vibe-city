/* Where every clickable object of a room stands and how it is marked: its footprint box (u, v, h, du, dv, dh) for
   hit-testing, the hover outline and its marker. Data only (no drawing), so the layout rules can be tested: see
   controls.test.ts.

   A floor reads in zones: the left wall is its records (file archive, schedules clock above it, by the elevator),
   the back corner is the lead's office, the right wall is the work (the Ops board, then the equipment bay every
   agent draws from: tools rack, skill shelf, key safe). Nothing stands in a walkway or in front of the elevator. */
import type { FloorObjectId } from '../data/floor';

export type Box6 = [number, number, number, number, number, number];
export interface Control<Id extends string> { id: Id; label: string; b: Box6 }

/* ---------------- a department floor ---------------- */

export type FloorObject = Control<FloorObjectId>;

const COMMON: FloorObject[] = [
  { id: 'board', label: 'Ops board', b: [95, 138, 4, 82, 2, 38] },
  { id: 'lead', label: 'Lead’s office', b: [12, 114, 0, 40, 20, 26] },
  { id: 'archive', label: 'File archive', b: [0, 58, 0, 12, 28, 24] },
  { id: 'clock', label: 'Schedules', b: [-1, 72, 34, 2, 16, 14] },
  { id: 'rack', label: 'Tools', b: [183, 126, 0, 14, 14, 40] },
  { id: 'library', label: 'Skills', b: [200, 128, 0, 22, 12, 38] },
  { id: 'keys', label: 'Env variables', b: [225, 136, 6, 12, 4, 26] },
];
/** The station stands where the lounge would be. */
export const STATION_BOX: Box6 = [200, 8, 0, 38, 34, 30];

export function floorObjects(stationName: string | null): FloorObject[] {
  return stationName ? [...COMMON, { id: 'station', label: stationName, b: STATION_BOX }] : COMMON;
}

/* ---------------- the Executive Office ---------------- */

export type ExecObjectId = 'desk' | 'board' | 'safe' | 'calendar' | 'trophy' | 'assistant' | 'library' | 'templates';
/** Against the back wall, where a floor's kitchen counter used to be: the same spot in every room. */
export const LIBRARY_BOX: Box6 = [192, 127, 0, 34, 13, 38];
export const EXEC_OBJECTS: Control<ExecObjectId>[] = [
  { id: 'desk', label: 'Your desk', b: [13, 117, 0, 38, 16, 26] },
  { id: 'trophy', label: 'Quest log', b: [0, 118, 0, 8, 20, 46] },
  { id: 'safe', label: 'Safe', b: [0, 70, 0, 16, 18, 20] },
  { id: 'calendar', label: 'Calendar', b: [-1, 76, 21, 2, 15, 19] },
  { id: 'board', label: 'Ops board', b: [92, 138, 6, 88, 2, 38] },
  { id: 'assistant', label: 'Chief of Staff', b: [104, 92, 0, 8, 8, 34] },
  { id: 'library', label: 'Skill library', b: LIBRARY_BOX },
  { id: 'templates', label: 'Templates', b: [206, 12, 0, 22, 18, 40] },
];
