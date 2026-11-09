import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ModelChecks1794182400000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE model_checks (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES users(id),
      model_id uuid NOT NULL REFERENCES model_connections(id),
      idempotency_key varchar(128) NOT NULL,
      status varchar(16) NOT NULL CHECK(status IN ('running','passed','failed','unknown')),
      dispatched boolean NOT NULL DEFAULT false,
      failure_code text,
      input_tokens integer,
      output_tokens integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL DEFAULT now() + interval '90 seconds',
      completed_at timestamptz,
      resolved_at timestamptz,
      resolution_note text,
      UNIQUE(owner_id,idempotency_key)
    );
    CREATE INDEX model_checks_history ON model_checks(model_id,created_at DESC,id);
    CREATE UNIQUE INDEX model_checks_unresolved ON model_checks(model_id)
      WHERE status='running' OR (status='unknown' AND resolved_at IS NULL);`);
  }
  async down(): Promise<void> {
    throw new Error('Model checks contain external-call evidence. Restore a verified backup.');
  }
}
