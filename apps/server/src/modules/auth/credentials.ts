import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const hashToken = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export async function hashPassword(secret: string): Promise<string> {
  if (secret.length < 12 || secret.length > 256)
    throw new Error('Use a password of 12 to 256 characters');
  const salt = randomBytes(16).toString('hex');
  const key = (await derive(secret, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(secret: string, encoded: string): Promise<boolean> {
  const [algorithm, salt, hex] = encoded.split(':');
  if (algorithm !== 'scrypt' || !salt || !hex || !/^[0-9a-f]{128}$/.test(hex)) return false;
  const key = (await derive(secret, salt, 64)) as Buffer;
  return timingSafeEqual(key, Buffer.from(hex, 'hex'));
}

export function readSessionCookie(header?: string): string | null {
  const token = header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('creator_session='))
    ?.slice(16);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
