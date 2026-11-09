import 'reflect-metadata';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createDataSource } from './database/data-source';
import { readEnvironment } from './config/environment';
import { createAdmin } from './modules/auth/bootstrap';

async function main() {
  const env = readEnvironment();
  const db = await createDataSource(env.databaseUrl).initialize();
  try {
    if (process.argv[2] === 'migrate') {
      const lock = db.createQueryRunner();
      await lock.connect();
      try {
        await lock.query('SELECT pg_advisory_lock(719240)');
        const migrations = await db.runMigrations({ transaction: 'all' });
        console.log(`Applied ${migrations.length} migration(s).`);
      } finally {
        await lock.query('SELECT pg_advisory_unlock(719240)');
        await lock.release();
      }
    } else if (process.argv[2] === 'admin:create') {
      let username = process.env.ADMIN_USERNAME;
      let secret = process.env.ADMIN_PASSWORD;
      if (!username || !secret) {
        if (!process.stdin.isTTY)
          throw new Error(
            'Use an interactive terminal or supply ADMIN_USERNAME and ADMIN_PASSWORD',
          );
        let muted = false;
        const output = new Writable({
          write(chunk, _encoding, callback) {
            if (!muted) process.stdout.write(chunk);
            callback();
          },
        });
        const prompt = createInterface({ input: process.stdin, output, terminal: true });
        try {
          username ??= await prompt.question('Admin username: ');
          process.stdout.write('Admin password (12+ characters, hidden): ');
          muted = true;
          secret ??= await prompt.question('');
          muted = false;
          process.stdout.write('\n');
        } finally {
          prompt.close();
        }
      }
      // Bootstrap does not expose an HTTP route or require a running Redis service.
      await createAdmin(db, username, secret);
      console.log('Administrator created. Bootstrap is now closed.');
    } else throw new Error('Usage: cli migrate | admin:create');
  } finally {
    await db.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error && !('driverError' in error)
      ? error.message
      : 'Database operation failed; check service connectivity and migrations.',
  );
  process.exitCode = 1;
});
