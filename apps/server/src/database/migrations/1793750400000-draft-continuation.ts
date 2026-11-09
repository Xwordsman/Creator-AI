import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DraftContinuation1793750400000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE creation_runs ADD COLUMN parent_run_id uuid REFERENCES creation_runs(id);
      ALTER TABLE creation_runs ADD COLUMN root_run_id uuid REFERENCES creation_runs(id);
      ALTER TABLE creation_runs ADD COLUMN continuation_depth integer NOT NULL DEFAULT 0;
      ALTER TABLE creation_runs ADD CONSTRAINT creation_runs_lineage_check CHECK (
        (parent_run_id IS NULL AND root_run_id IS NULL AND continuation_depth = 0) OR
        (parent_run_id IS NOT NULL AND root_run_id IS NOT NULL AND continuation_depth BETWEEN 1 AND 100)
      );
      CREATE INDEX creation_runs_history ON creation_runs(owner_id, (COALESCE(root_run_id, id)), created_at, id);
    `);
  }
  async down(): Promise<void> {
    throw new Error('Draft lineage must be retained. Restore a verified backup.');
  }
}
