import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AgentRuntime1793664000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE creation_runs DROP CONSTRAINT creation_runs_status_check;
      ALTER TABLE creation_runs ADD CONSTRAINT creation_runs_status_check
        CHECK (status IN ('queued','running','succeeded','failed','cancelled','needs_review'));
      ALTER TABLE creation_runs ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;
      ALTER TABLE creation_runs ADD COLUMN started_at timestamptz;
      ALTER TABLE creation_runs ADD COLUMN charged_tokens integer NOT NULL DEFAULT 0;
      ALTER TABLE creation_runs ADD COLUMN reserved_tokens integer NOT NULL DEFAULT 0;
      ALTER TABLE creation_runs ADD COLUMN invocation_count integer NOT NULL DEFAULT 0;
      CREATE TABLE model_connections (
        id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        config jsonb NOT NULL, encrypted_key text NOT NULL,
        enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX model_connections_owner ON model_connections(owner_id);
      CREATE TABLE agent_runs (
        id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES creation_runs(id) ON DELETE CASCADE,
        agent_id varchar(80) NOT NULL, name varchar(80) NOT NULL, role varchar(12) NOT NULL,
        phase integer NOT NULL, task text NOT NULL, dependencies jsonb NOT NULL DEFAULT '[]',
        definition jsonb NOT NULL, status varchar(24) NOT NULL DEFAULT 'pending',
        messages jsonb NOT NULL DEFAULT '[]', loaded_skill_keys jsonb NOT NULL DEFAULT '[]',
        result text, failure_code text, UNIQUE(run_id, phase, agent_id)
      );
      CREATE INDEX agent_runs_run ON agent_runs(run_id, phase);
      CREATE TABLE model_invocations (
        id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES creation_runs(id) ON DELETE CASCADE,
        agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        turn integer NOT NULL, status varchar(24) NOT NULL,
        reserved_tokens integer NOT NULL, input_tokens integer, output_tokens integer,
        request_hash text NOT NULL, response jsonb, provider_request_id text, failure_code text,
        created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
        UNIQUE(agent_run_id, turn)
      );
      CREATE INDEX model_invocations_run ON model_invocations(run_id);
      CREATE TABLE tool_executions (
        id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES creation_runs(id) ON DELETE CASCADE,
        agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        name varchar(80) NOT NULL, input jsonb NOT NULL, result text NOT NULL,
        status varchar(24) NOT NULL, call_id varchar(240) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(agent_run_id, call_id)
      );
      CREATE INDEX tool_executions_run ON tool_executions(run_id);
      CREATE TABLE team_messages (
        id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES creation_runs(id) ON DELETE CASCADE,
        sender varchar(80) NOT NULL, recipient varchar(80) NOT NULL, kind varchar(24) NOT NULL,
        content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX team_messages_run ON team_messages(run_id);
      CREATE TABLE invocation_reconciliations (
        id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES creation_runs(id) ON DELETE CASCADE,
        owner_id uuid NOT NULL REFERENCES users(id), note text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
  async down(): Promise<void> {
    throw new Error('Invocation and budget evidence must be retained. Restore a verified backup.');
  }
}
