import { randomBytes } from 'node:crypto';
import {
  decryptModelKey,
  encryptModelKey,
  isPublicAddress,
  resolveModelAddress,
  validateModelUrl,
} from './model-security';

describe('model endpoint and credential boundaries', () => {
  const env = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      MODEL_MODE: 'configured',
      MODEL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      MODEL_ALLOWED_HOSTS: 'api.example.com,127.0.0.1:8080,[::1]:8080',
      MODEL_ALLOW_LOCAL: 'false',
    });
  });
  afterEach(() => {
    process.env = { ...env };
  });
  it('requires exact whitelisted HTTPS endpoints without embedded authentication', () => {
    expect(validateModelUrl('https://api.example.com/v1').host).toBe('api.example.com');
    for (const value of [
      'https://api.example.com.attacker.test/v1',
      'https://api.example.com:8443/v1',
      'http://api.example.com/v1',
      'https://user:secret@api.example.com/v1',
      'https://api.example.com/v1?q=key',
      'https://api.example.com/v1#secret',
    ])
      expect(() => validateModelUrl(value)).toThrow();
    process.env.MODEL_MODE = 'mock';
    expect(() => validateModelUrl('https://api.example.com/v1')).toThrow();
  });
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.1.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    'fe80::1',
    '2001:db8::1',
    '2001:0:1234::1',
    '2002:7f00:1::1',
    '3fff::1',
  ])('denies non-public destination %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it('allows public unicast destinations', () => {
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('limits loopback HTTP to explicit non-production development', async () => {
    expect(() => validateModelUrl('http://127.0.0.1:8080/v1')).toThrow();
    process.env.MODEL_ALLOW_LOCAL = 'true';
    const url = validateModelUrl('http://127.0.0.1:8080/v1');
    expect(await resolveModelAddress(url)).toEqual({ address: '127.0.0.1', family: 4 });
    expect(await resolveModelAddress(validateModelUrl('http://[::1]:8080/v1'))).toEqual({
      address: '::1',
      family: 6,
    });
    process.env.NODE_ENV = 'production';
    await expect(resolveModelAddress(url)).rejects.toThrow();
    expect(() => validateModelUrl(url.href)).toThrow();
  });
  it('authenticates encrypted keys against owner and connection identities', () => {
    const cipher = encryptModelKey('fixture-key', 'owner:connection');
    expect(cipher).not.toContain('fixture-key');
    expect(decryptModelKey(cipher, 'owner:connection')).toBe('fixture-key');
    expect(() => decryptModelKey(cipher, 'other:connection')).toThrow();
    const parts = cipher.split('.');
    parts[2] = Buffer.from('tampered').toString('base64');
    expect(() => decryptModelKey(parts.join('.'), 'owner:connection')).toThrow();
  });
});
