import { randomBytes } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';

export const productionKeys = [
  'COMPOSE_PROJECT_NAME',
  'DB_PASSWORD',
  'APP_ORIGIN',
  'SITE_ADDRESS',
  'HTTP_PORT',
  'HTTPS_PORT',
  'MODEL_MODE',
  'MODEL_ENCRYPTION_KEY',
  'MODEL_ALLOWED_HOSTS',
];

function fail(message) {
  throw new Error(message);
}

export function validateProductionConfig(config) {
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(config.COMPOSE_PROJECT_NAME ?? ''))
    fail('COMPOSE_PROJECT_NAME must be a stable lowercase project name.');
  let origin;
  try {
    origin = new URL(config.APP_ORIGIN);
  } catch {
    fail('APP_ORIGIN must be an exact public HTTPS origin.');
  }
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== config.APP_ORIGIN ||
    origin.port ||
    !validHostname(origin.hostname)
  )
    fail('APP_ORIGIN must use a public DNS name, HTTPS and the standard port, without a path.');
  if (config.SITE_ADDRESS !== origin.hostname)
    fail('SITE_ADDRESS must match the hostname in APP_ORIGIN.');
  if (config.HTTP_PORT !== '80' || config.HTTPS_PORT !== '443')
    fail('The production entry point requires HTTP_PORT=80 and HTTPS_PORT=443.');
  if (config.MODEL_MODE !== 'configured')
    fail('The production entry point requires MODEL_MODE=configured.');
  for (const key of ['DB_PASSWORD', 'MODEL_ENCRYPTION_KEY'])
    if (!/^[a-f0-9]{64}$/i.test(config[key] ?? '')) fail(`${key} must contain 64 hex digits.`);
  if (config.DB_PASSWORD === config.MODEL_ENCRYPTION_KEY)
    fail('Database and encryption secrets must be different.');
  const hosts = (config.MODEL_ALLOWED_HOSTS ?? '').split(',');
  if (
    !hosts.length ||
    hosts.length > 32 ||
    hosts.some((host) => {
      const [hostname, port, ...extra] = host.split(':');
      return (
        extra.length ||
        !validHostname(hostname) ||
        (port !== undefined && (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535))
      );
    }) ||
    new Set(hosts).size !== hosts.length
  )
    fail('MODEL_ALLOWED_HOSTS must list unique public DNS hosts, with optional ports.');
  return config;
}

function validHostname(value = '') {
  return (
    value.length <= 253 &&
    value === value.toLowerCase() &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value) &&
    !['localhost', 'local', 'internal', 'invalid', 'test'].some(
      (suffix) => value === suffix || value.endsWith(`.${suffix}`),
    )
  );
}

export function createProductionConfig({ origin, modelHosts, project = 'creator-ai' }) {
  let hostname;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    fail('Supply --origin with your public HTTPS origin.');
  }
  return validateProductionConfig({
    COMPOSE_PROJECT_NAME: project,
    DB_PASSWORD: randomBytes(32).toString('hex'),
    APP_ORIGIN: origin,
    SITE_ADDRESS: hostname,
    HTTP_PORT: '80',
    HTTPS_PORT: '443',
    MODEL_MODE: 'configured',
    MODEL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    MODEL_ALLOWED_HOSTS: modelHosts,
  });
}

export function parseProductionEnv(text) {
  const config = {};
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^\s'"`$#\\]*)$/.exec(line);
    if (!match || !productionKeys.includes(match[1]) || Object.hasOwn(config, match[1]))
      fail('Invalid production env file: use unique, unquoted supported KEY=value lines.');
    config[match[1]] = match[2];
  }
  return validateProductionConfig(config);
}

export async function writeProductionEnv(path, config) {
  validateProductionConfig(config);
  const text = [
    '# Private production configuration. Keep an independent encrypted backup.',
    '# Do not regenerate MODEL_ENCRYPTION_KEY after storing model credentials.',
    ...productionKeys.map((key) => `${key}=${config[key]}`),
    '',
  ].join('\n');
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function readProductionEnv(path) {
  const info = await stat(path);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
    fail('Production configuration must be a private regular file (chmod 600).');
  return parseProductionEnv(await readFile(path, 'utf8'));
}

export function productionProcessEnv(inherited = process.env) {
  // Compose interpolation must use the selected env file, not a stale shell or preview config.
  return Object.fromEntries([
    ...Object.entries(inherited).filter(
      ([key]) =>
        !productionKeys.includes(key) &&
        !key.startsWith('COMPOSE_') &&
        !key.startsWith('ADMIN_') &&
        !key.startsWith('MODEL_'),
    ),
    ['COMPOSE_ANSI', 'never'],
  ]);
}

export function assertProductionCompose(rendered, config) {
  const denied = () => fail('Production Compose configuration does not match the validated env.');
  const project = config.COMPOSE_PROJECT_NAME;
  if (rendered.name !== project) denied();
  if (
    Object.keys(rendered.services ?? {})
      .sort()
      .join(',') !== 'api,database,gateway,redis,worker'
  )
    denied();
  for (const [name, service] of Object.entries(rendered.services)) {
    if (service.privileged || service.container_name || service.network_mode) denied();
    if (name !== 'gateway' && service.ports?.length) denied();
    for (const mount of service.volumes ?? [])
      if (mount.type !== 'volume' || !Object.hasOwn(rendered.volumes ?? {}, mount.source)) denied();
    if (service.logging?.options?.['max-size'] !== '10m') denied();
  }
  for (const name of ['api', 'worker']) {
    const service = rendered.services[name];
    for (const key of ['APP_ORIGIN', 'MODEL_MODE', 'MODEL_ENCRYPTION_KEY', 'MODEL_ALLOWED_HOSTS'])
      if (service.environment?.[key] !== config[key]) denied();
    if (
      service.environment.NODE_ENV !== 'production' ||
      service.environment.DATABASE_URL !==
        `postgres://creator:${config.DB_PASSWORD}@database:5432/creator` ||
      service.environment.REDIS_URL !== 'redis://redis:6379/0' ||
      Object.keys(service.networks ?? {})
        .sort()
        .join(',') !== 'model_egress,private' ||
      !service.read_only ||
      !service.cap_drop?.includes('ALL')
    )
      denied();
  }
  const gateway = rendered.services.gateway;
  if (gateway.environment?.SITE_ADDRESS !== config.SITE_ADDRESS) denied();
  if (
    gateway.ports?.length !== 2 ||
    ![80, 443].every((port) =>
      gateway.ports.some(
        (binding) =>
          binding.target === port && +binding.published === port && binding.protocol === 'tcp',
      ),
    )
  )
    denied();
  if (!rendered.networks?.private?.internal) denied();
  for (const section of ['networks', 'volumes'])
    for (const [key, resource] of Object.entries(rendered[section] ?? {}))
      if (resource.external || resource.driver_opts || resource.name !== `${project}_${key}`)
        denied();
  if (
    Object.keys(rendered.volumes ?? {})
      .sort()
      .join(',') !== 'caddy_config,caddy_data,database_data,redis_data'
  )
    denied();
}
