import type { RunSnapshot } from '@creator-ai/contracts';
import { MockTextProvider } from './mock-provider';

export const snapshot: RunSnapshot = {
  schemaVersion: 1,
  topic: 'A test topic',
  brief: 'A test brief',
  provider: 'mock',
  workflow: 'mock-article-v1',
  skills: [],
  account: {
    revision: 1,
    defaultExpertId: null,
    id: 'account',
    name: 'Account',
    platform: 'wechat',
    audience: 'Readers',
    persona: 'Do not invent experiences',
    createdAt: '2026-11-01T00:00:00Z',
  },
  expert: {
    id: 'expert',
    name: 'Editor',
    version: 2,
    description: 'Description',
    instructions: 'Do not invent sources',
    skillKeys: ['fact-check'],
    createdAt: '2026-11-01T00:00:00Z',
  },
};

describe('mock provider', () => {
  it('is deterministic, explicitly mock and pending review', async () => {
    const provider = new MockTextProvider();
    expect(await provider.generate(snapshot)).toEqual(await provider.generate(snapshot));
    expect(await provider.generate(snapshot)).toMatchObject({
      isMock: true,
      reviewStatus: 'pending_review',
      schemaVersion: 1,
    });
  });
  it('uses only the supplied account snapshot and represents markup as text', async () => {
    const result = await new MockTextProvider().generate({
      ...snapshot,
      topic: '<script>alert(1)</script>',
    });
    expect(result.document.type).toBe('doc');
    expect(
      result.document.content?.every((node) => ['paragraph', 'heading'].includes(node.type)),
    ).toBe(true);
    expect(JSON.stringify(result)).toContain('<script>');
    expect(JSON.stringify(result)).toContain(snapshot.account.persona);
  });
});
