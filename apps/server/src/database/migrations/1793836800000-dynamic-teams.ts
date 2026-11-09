import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DynamicTeams1793836800000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE creation_runs DROP CONSTRAINT creation_runs_status_check;
      ALTER TABLE creation_runs ADD CONSTRAINT creation_runs_status_check
        CHECK (status IN ('queued','running','waiting_user','succeeded','failed','cancelled','needs_review'));
      ALTER TABLE creation_runs ADD COLUMN active_ms integer NOT NULL DEFAULT 0 CHECK (active_ms >= 0);
      ALTER TABLE creation_runs ADD COLUMN active_started_at timestamptz;
      ALTER TABLE creation_runs ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0;
      CREATE TABLE team_actions (
        id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES creation_runs(id) ON DELETE CASCADE,
        source_agent_run_id uuid NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
        directive jsonb NOT NULL, state varchar(16) NOT NULL CHECK (state IN ('waiting','applied','peer_wait')),
        response jsonb, spawned_agent_ids jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX team_actions_run ON team_actions(run_id,created_at,id);
      CREATE UNIQUE INDEX team_actions_one_wait ON team_actions(run_id) WHERE state='waiting' AND response IS NULL;
    `);
  }
  async down(): Promise<void> {
    throw new Error('Plans and user decisions are execution evidence. Restore a verified backup.');
  }
}
