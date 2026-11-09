import { config } from 'dotenv';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { modelSettings } from '../modules/models/model-security';

config({ path: resolve(__dirname, '../../../../.env'), quiet: true });

export interface Environment {
  databaseUrl: string;
  redisUrl: string;
  origin: string;
  port: number;
  bindHost: string;
  secureCookies: boolean;
}

export function readEnvironment(): Environment {
  const databaseUrl = required('DATABASE_URL');
  const redisUrl = required('REDIS_URL');
  const origin = required('APP_ORIGIN');
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
    throw new Error('APP_ORIGIN must be an exact HTTP(S) origin without a trailing slash');
  }
  if (!['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL');
  }
  if (!['redis:', 'rediss:'].includes(new URL(redisUrl).protocol)) {
    throw new Error('REDIS_URL must use Redis');
  }
  if (!['mock', 'configured'].includes(process.env.MODEL_MODE ?? 'mock'))
    throw new Error('Invalid MODEL_MODE');
  if (process.env.MODEL_MODE === 'configured' && !modelSettings().canConfigureModels)
    throw new Error(
      'Configured models require MODEL_ENCRYPTION_KEY (64 hex) and MODEL_ALLOWED_HOSTS',
    );
  if (process.env.NODE_ENV === 'production' && process.env.MODEL_ALLOW_LOCAL === 'true')
    throw new Error('Local model egress is not permitted in production');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (process.env.NODE_ENV === 'production' && !local && url.protocol !== 'https:') {
    throw new Error('Public production deployments require HTTPS');
  }
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const bindHost = process.env.BIND_HOST ?? '0.0.0.0';
  if (!isIP(bindHost)) throw new Error('BIND_HOST must be an IP address');
  return {
    databaseUrl,
    redisUrl,
    origin,
    port,
    bindHost,
    secureCookies: url.protocol === 'https:',
  };
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}
