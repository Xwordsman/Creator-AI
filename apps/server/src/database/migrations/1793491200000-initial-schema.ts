import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1793491200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY, username varchar(80) UNIQUE NOT NULL,
        password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE sessions (
        token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token text NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE INDEX sessions_expiry ON sessions(expires_at);
      CREATE TABLE accounts (
        id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id),
        profile jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX accounts_owner ON accounts(owner_id);
      CREATE TABLE experts (
        id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), version integer NOT NULL CHECK (version > 0),
        definition jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX experts_owner ON experts(owner_id);
      CREATE TABLE expert_versions (
        expert_id uuid NOT NULL REFERENCES experts(id), version integer NOT NULL,
        definition jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (expert_id, version)
      );
      CREATE TABLE creation_runs (
        id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id),
        idempotency_key varchar(128) NOT NULL, input_hash text NOT NULL,
        status varchar(24) NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
        revision integer NOT NULL DEFAULT 1, attempts integer NOT NULL DEFAULT 0,
        snapshot jsonb NOT NULL, output jsonb, failure_code text,
        lease_token uuid, lease_expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (owner_id, idempotency_key)
      );
      CREATE INDEX runs_owner_created ON creation_runs(owner_id, created_at DESC);
      CREATE INDEX runs_recovery ON creation_runs(status, lease_expires_at);
      CREATE TABLE task_outbox (
        run_id uuid PRIMARY KEY REFERENCES creation_runs(id) ON DELETE CASCADE,
        sequence integer NOT NULL DEFAULT 0, last_dispatched_at timestamptz
      );
    `);
  }

  async down(): Promise<void> {
    throw new Error(
      'Initial schema rollback would destroy content. Restore a verified backup instead.',
    );
  }
}
