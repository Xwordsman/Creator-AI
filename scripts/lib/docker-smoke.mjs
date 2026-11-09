import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export function createIdentity() {
  const project = `creator-ai-smoke-${randomBytes(6).toString('hex')}`;
  return {
    project,
    serverImage: `${project}-server:local`,
    webImage: `${project}-web:local`,
    databaseSecret: randomBytes(32).toString('hex'),
    adminUsername: 'smoke-admin',
    adminSecret: randomBytes(32).toString('hex'),
  };
}

export function assertComposeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match)
    throw new Error('Cannot identify Docker Compose version. Compose >= 2.24.4 is required.');
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (major < 2 || (major === 2 && (minor < 24 || (minor === 24 && patch < 4)))) {
    throw new Error('Docker Compose >= 2.24.4 is required for the isolated port override.');
  }
}

export function assertLocalEndpoint(endpoint) {
  if (!endpoint.startsWith('unix:///') && !endpoint.startsWith('npipe:////./pipe/')) {
    throw new Error(
      'Docker smoke tests require a local Unix socket or Windows named pipe; remote/TCP engines are refused.',
    );
  }
}

export function assertIsolatedConfig(config, identity, port) {
  const fail = () => {
    throw new Error(
      'Compose isolation check failed. Refusing to create or remove Docker resources.',
    );
  };
  if (
    !/^creator-ai-smoke-[a-f0-9]{12}$/.test(identity.project) ||
    config.name !== identity.project ||
    identity.serverImage !== `${identity.project}-server:local` ||
    identity.webImage !== `${identity.project}-web:local`
  )
    fail();
  const names = Object.keys(config.services ?? {})
    .sort()
    .join(',');
  if (names !== 'api,database,gateway,redis,worker') fail();
  if (
    config.services.api.image !== identity.serverImage ||
    config.services.worker.image !== identity.serverImage ||
    config.services.gateway.image !== identity.webImage
  )
    fail();

  for (const [name, service] of Object.entries(config.services)) {
    if (service.container_name || service.privileged || service.network_mode || service.env_file)
      fail();
    if (name === 'gateway') {
      const [binding, ...rest] = service.ports ?? [];
      if (
        !binding ||
        rest.length ||
        binding.host_ip !== '127.0.0.1' ||
        Number(binding.published) !== port ||
        binding.target !== 80 ||
        binding.protocol !== 'tcp'
      )
        fail();
    } else if (service.ports?.length) fail();
    for (const mount of service.volumes ?? []) {
      if (mount.type !== 'volume' || !Object.hasOwn(config.volumes ?? {}, mount.source)) fail();
    }
  }
  for (const section of ['networks', 'volumes']) {
    if (!Object.keys(config[section] ?? {}).length) fail();
    for (const [key, resource] of Object.entries(config[section])) {
      if (
        resource.external ||
        resource.name !== `${identity.project}_${key}` ||
        resource.driver_opts
      )
        fail();
    }
  }
  if (!config.networks.private?.internal) fail();
  for (const name of ['api', 'worker']) {
    const service = config.services[name];
    if (
      Object.keys(service.networks ?? {}).join(',') !== 'private' ||
      service.environment?.MODEL_MODE !== 'mock' ||
      service.environment?.APP_ORIGIN !== `http://127.0.0.1:${port}`
    )
      fail();
  }
}

export function redact(text, secrets) {
  return secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((value, secret) => value.split(secret).join('[redacted]'), text);
}

export function runProcess(executable, args, { cwd, env, timeoutMs = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      signal,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-128000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-128000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Command timed out after ${timeoutMs / 1000}s.`));
      else resolve({ code, stdout, stderr });
    });
  });
}
