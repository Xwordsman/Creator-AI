import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { UserEntity } from '../../database/entities';
import { hashPassword } from './credentials';

// CLI-only bootstrap: the advisory lock closes the race between two initializers.
export async function createAdmin(db: DataSource, username: string, secret: string): Promise<void> {
  if (!/^[a-zA-Z0-9_.-]{3,80}$/.test(username))
    throw new Error('Username must be 3-80 letters, digits, dots, hyphens or underscores');
  const passwordHash = await hashPassword(secret);
  await db.transaction(async (em) => {
    await em.query('SELECT pg_advisory_xact_lock(719241)');
    if (await em.count(UserEntity))
      throw new Error('Administrator already exists; bootstrap is closed');
    await em.insert(UserEntity, {
      id: randomUUID(),
      username,
      passwordHash,
      createdAt: new Date(),
    });
  });
}
