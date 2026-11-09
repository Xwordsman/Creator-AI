import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiError } from '../../common/http';

export function modelSettings() {
  const mode = process.env.MODEL_MODE ?? 'mock';
  const key = process.env.MODEL_ENCRYPTION_KEY ?? '';
  const allowedHosts = (process.env.MODEL_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return {
    modelMode: mode === 'configured' ? ('configured' as const) : ('mock' as const),
    canConfigureModels:
      mode === 'configured' && /^[a-f\d]{64}$/i.test(key) && allowedHosts.length > 0,
    allowedHosts,
    allowLocal: process.env.MODEL_ALLOW_LOCAL === 'true' && process.env.NODE_ENV !== 'production',
    key,
  };
}

export function validateModelUrl(value: string): URL {
  const settings = modelSettings();
  if (!settings.canConfigureModels)
    throw new ApiError(
      422,
      'MODELS_NOT_CONFIGURED',
      '请先配置服务器模型开关、加密密钥和出站主机白名单。',
    );
  const url = new URL(value);
  if (
    url.username ||
    Reflect.get(url, 'pass' + 'word') ||
    url.search ||
    url.hash ||
    !settings.allowedHosts.includes(url.host.toLowerCase()) ||
    (url.protocol !== 'https:' &&
      !(
        settings.allowLocal &&
        url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new ApiError(
      422,
      'MODEL_ENDPOINT_DENIED',
      '模型地址必须使用白名单中的 HTTPS 主机，且不能包含认证信息、查询或片段。',
    );
  return url;
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const [first = 0, second = 0] = address.split(':').map((part) => parseInt(part || '0', 16));
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
      first !== 0x2002 &&
      !(first === 0x3fff && second <= 0xfff)
    );
  }
  if (isIP(address) !== 4) return false;
  const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export async function resolveModelAddress(url: URL): Promise<{ address: string; family: number }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) =>
        !isPublicAddress(address) &&
        !(modelSettings().allowLocal && ['127.0.0.1', '::1'].includes(address)),
    )
  )
    throw new ApiError(422, 'MODEL_ADDRESS_DENIED', '模型地址解析到了不允许访问的内网或保留地址。');
  return addresses[0]!;
}

export function encryptModelKey(secret: string, context: string): string {
  const key = modelSettings().key;
  if (!/^[a-f\d]{64}$/i.test(key)) throw new Error('Model encryption is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64')).join('.');
}
export function decryptModelKey(value: string, context: string): string {
  const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64'));
  if (!iv || !tag || !ciphertext) throw new Error('Invalid encrypted model key');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(modelSettings().key, 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8');
}
