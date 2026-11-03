import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { CompanyView } from '@vibe-city/shared';

export const DEFAULT_COMPANY_NAME = 'My Company';

interface CompanyRow { id: string; name: string; created_at: string }

export class CompanyService {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Idempotent: a fresh install gets exactly one company (enforced by the singleton PK). */
  ensureCompany(): CompanyRow {
    this.db
      .prepare('INSERT OR IGNORE INTO company (singleton, id, name, created_at) VALUES (1, ?, ?, ?)')
      .run(randomUUID(), DEFAULT_COMPANY_NAME, new Date().toISOString());
    return this.row();
  }

  row(): CompanyRow {
    return this.db.prepare('SELECT id, name, created_at FROM company WHERE singleton = 1').get() as unknown as CompanyRow;
  }

  view(): CompanyView {
    const c = this.row();
    const depts = this.db
      .prepare('SELECT id FROM department WHERE archived_at IS NULL ORDER BY floor_order DESC, id ASC')
      .all() as unknown as { id: string }[];
    return {
      id: c.id,
      name: c.name,
      createdAt: c.created_at,
      // The Executive Office is a logical, permanent entity: not stored as a department, so it cannot be deleted.
      executiveOffice: { id: 'executive-office', name: 'Executive Office', position: 'top', deletable: false },
      floors: [{ kind: 'executive' }, ...depts.map((d) => ({ kind: 'department' as const, departmentId: d.id }))],
    };
  }
}
