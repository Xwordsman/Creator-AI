import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CapabilityReuse1794009600000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE accounts ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
      ALTER TABLE accounts ADD COLUMN default_expert_id uuid;
      ALTER TABLE experts ADD CONSTRAINT experts_owner_identity UNIQUE(owner_id, id);
      ALTER TABLE accounts ADD CONSTRAINT accounts_default_expert_owner
        FOREIGN KEY(owner_id, default_expert_id) REFERENCES experts(owner_id, id);
      ALTER TABLE expert_versions ADD COLUMN restored_from integer;
      ALTER TABLE expert_versions ADD CONSTRAINT expert_restore_source
        FOREIGN KEY(expert_id, restored_from) REFERENCES expert_versions(expert_id, version);
      ALTER TABLE skill_versions ADD COLUMN restored_from integer;
      ALTER TABLE skill_versions ADD CONSTRAINT skill_restore_source
        FOREIGN KEY(skill_id, restored_from) REFERENCES skill_versions(skill_id, version);
    `);
  }
  async down(): Promise<void> {
    throw new Error('Capability history and bindings must be retained. Restore a verified backup.');
  }
}
