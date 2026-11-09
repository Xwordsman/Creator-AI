import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ContentAssistance1794096000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE content_turns (
        run_id uuid PRIMARY KEY REFERENCES creation_runs(id),
        content_id uuid NOT NULL REFERENCES content_items(id),
        base_version integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(content_id,base_version) REFERENCES content_versions(content_id,version)
      );
      CREATE INDEX content_turns_history ON content_turns(content_id,created_at DESC,run_id);
    `);
  }
  async down(): Promise<void> {
    throw new Error(
      'Conversation and model-call evidence must be retained. Restore a verified backup.',
    );
  }
}
