import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ContentWorkflow1793923200000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE content_items (
        id uuid PRIMARY KEY,
        owner_id uuid NOT NULL REFERENCES users(id),
        source_run_id uuid NOT NULL UNIQUE REFERENCES creation_runs(id),
        account_name text NOT NULL,
        platform text NOT NULL,
        is_mock boolean NOT NULL,
        title text NOT NULL,
        status text NOT NULL CHECK (status IN ('draft','pending_review','approved','changes_requested')),
        current_version integer NOT NULL CHECK (current_version > 0),
        revision integer NOT NULL CHECK (revision > 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX content_items_owner ON content_items(owner_id, updated_at DESC, id);
      CREATE TABLE content_versions (
        content_id uuid NOT NULL REFERENCES content_items(id),
        version integer NOT NULL CHECK (version > 0),
        title text NOT NULL,
        document jsonb NOT NULL,
        kind text NOT NULL CHECK (kind IN ('generated','edit','restore')),
        restored_from integer,
        note text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(content_id, version),
        FOREIGN KEY(content_id, restored_from) REFERENCES content_versions(content_id, version)
      );
      ALTER TABLE content_items ADD CONSTRAINT content_current_version_fk
        FOREIGN KEY(id, current_version) REFERENCES content_versions(content_id, version) DEFERRABLE INITIALLY DEFERRED;
      CREATE TABLE content_reviews (
        id uuid PRIMARY KEY,
        content_id uuid NOT NULL,
        version integer NOT NULL,
        action text NOT NULL CHECK (action IN ('submit','approve','request_changes')),
        note text NOT NULL,
        actor_id uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(content_id, version) REFERENCES content_versions(content_id, version)
      );
      CREATE INDEX content_reviews_history ON content_reviews(content_id, created_at, id);
      CREATE TABLE content_operations (
        content_id uuid NOT NULL REFERENCES content_items(id),
        key text NOT NULL,
        input_hash text NOT NULL,
        result jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(content_id, key)
      );
    `);
  }
  async down(): Promise<void> {
    throw new Error('Content and review evidence must be retained. Restore a verified backup.');
  }
}
