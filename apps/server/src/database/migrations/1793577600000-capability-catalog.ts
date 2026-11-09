import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CapabilityCatalog1793577600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE experts ADD COLUMN enabled boolean NOT NULL DEFAULT true;
      ALTER TABLE experts ADD COLUMN package_files jsonb;
      ALTER TABLE expert_versions ADD COLUMN package_files jsonb;
      CREATE TABLE skills (
        id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id),
        key varchar(161) NOT NULL, version integer NOT NULL CHECK (version > 0),
        enabled boolean NOT NULL DEFAULT true, definition jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (owner_id, key)
      );
      CREATE TABLE skill_versions (
        skill_id uuid NOT NULL REFERENCES skills(id), version integer NOT NULL CHECK (version > 0),
        definition jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (skill_id, version)
      );
    `);
  }
  async down(): Promise<void> {
    throw new Error('Capability versions must be preserved. Restore a verified backup instead.');
  }
}
