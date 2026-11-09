import { readEnvironment } from './environment';

describe('server binding', () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...original,
      DATABASE_URL: 'postgresql://preview@127.0.0.1:5432/preview',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
      APP_ORIGIN: 'http://127.0.0.1:5173',
      MODEL_MODE: 'mock',
      PORT: '3000',
    };
    delete process.env.BIND_HOST;
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('preserves the container default', () => {
    expect(readEnvironment().bindHost).toBe('0.0.0.0');
  });

  it('allows an explicit loopback binding for local previews', () => {
    process.env.BIND_HOST = '127.0.0.1';
    expect(readEnvironment().bindHost).toBe('127.0.0.1');
  });

  it('rejects a hostname or invalid binding', () => {
    process.env.BIND_HOST = 'localhost:3000';
    expect(() => readEnvironment()).toThrow('BIND_HOST must be an IP address');
  });
});
