import type { DataSource } from 'typeorm';

export async function assertDatabaseReady(db: DataSource): Promise<void> {
  const applied: { name: string }[] = await db.query('SELECT name FROM migrations');
  const names = new Set(applied.map((row) => row.name));
  if (db.migrations.some((migration) => !names.has(migration.name ?? migration.constructor.name))) {
    throw new Error(
      'Database has pending migrations; run the migration CLI before starting services',
    );
  }
}
