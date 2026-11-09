import { hashPassword, hashToken, readSessionCookie, verifyPassword } from './credentials';

describe('credentials', () => {
  it('salts hashes and verifies only the correct secret', async () => {
    const one = await hashPassword('test-secret-with-length');
    const two = await hashPassword('test-secret-with-length');
    expect(one).not.toBe(two);
    expect(await verifyPassword('test-secret-with-length', one)).toBe(true);
    expect(await verifyPassword('wrong', one)).toBe(false);
    expect(await verifyPassword('test-secret-with-length', 'invalid')).toBe(false);
  });
  it('refuses short bootstrap secrets', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
  });
  it('parses only an exact, well-formed session cookie', () => {
    const token = 'a'.repeat(64);
    expect(readSessionCookie(`other=1; creator_session=${token}; unrelated=2`)).toBe(token);
    expect(readSessionCookie(`other_creator_session=${token}`)).toBeNull();
    expect(readSessionCookie('creator_session=broken')).toBeNull();
    expect(hashToken(token)).not.toBe(token);
  });
});
