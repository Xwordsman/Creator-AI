import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import type { Environment } from '../../config/environment';

describe('session boundary', () => {
  const env = { origin: 'http://localhost:5173' } as Environment;
  const authenticate = jest
    .fn()
    .mockResolvedValue({ session: { csrfToken: 'expected' }, user: { id: 'owner' } });
  const auth = { authenticate } as unknown as AuthService;
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
  const guard = new AuthGuard(reflector, auth, env);
  const context = (method: string, headers: Record<string, string>) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ method, headers }) }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  it('rejects a foreign or missing Origin on writes', async () => {
    await expect(
      guard.canActivate(context('POST', { origin: 'https://attacker.example' })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(guard.canActivate(context('POST', {}))).rejects.toMatchObject({ status: 403 });
  });
  it('requires a per-session CSRF token', async () => {
    await expect(guard.canActivate(context('POST', { origin: env.origin }))).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      guard.canActivate(context('POST', { origin: env.origin, 'x-csrf-token': 'expected' })),
    ).resolves.toBe(true);
  });
  it('authenticates reads without requiring Origin', async () => {
    await expect(guard.canActivate(context('GET', {}))).resolves.toBe(true);
  });
});
