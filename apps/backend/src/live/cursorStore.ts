import type { DatabaseSync } from 'node:sqlite';

export interface CursorStore {
  get(board: string): number | null;
  set(board: string, lastEventId: number): void;
}

export class SqliteCursorStore implements CursorStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  get(board: string): number | null {
    const r = this.db.prepare('SELECT last_event_id AS n FROM event_cursor WHERE board_slug = ?').get(board) as { n: number } | undefined;
    return r ? r.n : null;
  }
  set(board: string, lastEventId: number): void {
    this.db.prepare(
      `INSERT INTO event_cursor (board_slug, last_event_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(board_slug) DO UPDATE SET last_event_id = MAX(last_event_id, excluded.last_event_id), updated_at = excluded.updated_at`,
    ).run(board, lastEventId, new Date().toISOString());
  }
}

export class MemoryCursorStore implements CursorStore {
  private m = new Map<string, number>();
  get(board: string) { return this.m.get(board) ?? null; }
  set(board: string, id: number) { this.m.set(board, Math.max(id, this.m.get(board) ?? 0)); }
}
