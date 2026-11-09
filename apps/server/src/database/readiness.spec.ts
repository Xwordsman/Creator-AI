import type { DataSource } from 'typeorm';
import { assertDatabaseReady } from './readiness';

describe('migration readiness', () => {
  const db = (names: string[]) =>
    ({
      migrations: [{ name: 'InitialSchema1793491200000' }],
      query: jest.fn().mockResolvedValue(names.map((name) => ({ name }))),
    }) as unknown as DataSource;

  it('rejects an empty migrations table instead of reporting ready', async () => {
    await expect(assertDatabaseReady(db([]))).rejects.toThrow('pending migrations');
  });
  it('requires every configured migration to have been applied', async () => {
    await expect(assertDatabaseReady(db(['InitialSchema1793491200000']))).resolves.toBeUndefined();
  });
});
