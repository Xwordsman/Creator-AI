import { describe, expect, it } from 'vitest';
import {
  accountInputSchema,
  accountDefaultExpertSchema,
  restoreCapabilitySchema,
  createRunSchema,
  continueRunSchema,
  expertInputSchema,
  isTerminal,
  runOutputSchema,
  teamDirectiveSchema,
  teamResponseSchema,
} from './index';

describe('public contracts', () => {
  it('supports optional defaults but requires explicit nullable, revision-checked binding changes', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(accountDefaultExpertSchema.parse({ expertId: null, baseRevision: 1 })).toEqual({
      expertId: null,
      baseRevision: 1,
    });
    expect(
      createRunSchema.parse({ accountId: id, topic: 'Use default', accountRevision: 2 }),
    ).toMatchObject({ accountId: id, accountRevision: 2 });
    for (const value of [
      { expertId: id },
      { expertId: id, baseRevision: 0 },
      { expertId: '', baseRevision: 1 },
      { expertId: id, baseRevision: 1, ownerId: id },
    ])
      expect(accountDefaultExpertSchema.safeParse(value).success).toBe(false);
  });
  it('pins only selected skills and shares the team binding without member overrides', () => {
    const base = {
      name: 'Writer',
      description: 'Writer',
      instructions: 'Write',
      skillKeys: ['custom:voice'],
    };
    expect(
      expertInputSchema.parse({ ...base, skillVersions: { 'custom:voice': 2 } }).skillVersions,
    ).toEqual({ 'custom:voice': 2 });
    for (const skillVersions of [
      { missing: 1 },
      { 'custom:voice': 0 },
      { 'custom:voice': 1.5 },
      { 'custom:voice': '2' },
    ])
      expect(expertInputSchema.safeParse({ ...base, skillVersions }).success).toBe(false);
    const team = {
      ...base,
      expertType: 'team',
      skillVersions: { 'custom:voice': 1 },
      team: {
        leadAgent: 'editor',
        members: [
          { ...base, agentId: 'editor' },
          { ...base, agentId: 'writer' },
        ],
      },
    };
    expect(expertInputSchema.safeParse(team).success).toBe(true);
    expect(
      expertInputSchema.safeParse({
        ...team,
        team: {
          ...team.team,
          members: [
            { ...team.team.members[0], skillVersions: { 'custom:voice': 2 } },
            team.team.members[1],
          ],
        },
      }).success,
    ).toBe(false);
  });
  it('bounds restore operations and does not accept definitions, permissions or availability overrides', () => {
    expect(restoreCapabilitySchema.parse({ version: 1, baseVersion: 3 })).toEqual({
      version: 1,
      baseVersion: 3,
    });
    for (const value of [
      { version: 0, baseVersion: 1 },
      { version: 1, baseVersion: 1.5 },
      { version: 1, baseVersion: 2, enabled: true },
      { version: 1, baseVersion: 2, definition: {} },
    ])
      expect(restoreCapabilitySchema.safeParse(value).success).toBe(false);
  });
  it('bounds continuation feedback and forbids overriding the frozen context or output', () => {
    expect(continueRunSchema.parse({ instruction: '  Shorten the opening  ' })).toEqual({
      instruction: 'Shorten the opening',
    });
    for (const input of [
      { instruction: ' ' },
      { instruction: 'a'.repeat(2001) },
      { instruction: 'Revise', parentRunId: 'other' },
      { instruction: 'Revise', modelConnectionId: 'other' },
      { instruction: 'Revise', previousOutput: {} },
      { instruction: 'Revise', limits: { maxCalls: 100 } },
    ])
      expect(continueRunSchema.safeParse(input).success).toBe(false);
  });
  it('rejects unknown permissions and unsafe skill identifiers', () => {
    expect(
      accountInputSchema.safeParse({
        name: 'A',
        platform: 'wechat',
        audience: 'B',
        persona: 'C',
        ownerId: 'other',
      }).success,
    ).toBe(false);
    expect(
      expertInputSchema.safeParse({
        name: 'A',
        description: 'B',
        instructions: 'C',
        skillKeys: ['../../shell'],
      }).success,
    ).toBe(false);
  });
  it('allows skill-free experts and non-enumerated skills without granting tools', () => {
    const base = {
      name: 'Writer',
      description: 'Writer',
      instructions: 'Write carefully',
      skillKeys: [],
    };
    expect(expertInputSchema.safeParse(base).success).toBe(true);
    expect(expertInputSchema.safeParse({ ...base, skillKeys: ['custom:voice'] }).success).toBe(
      true,
    );
    expect(expertInputSchema.safeParse({ ...base, tools: ['shell'] }).success).toBe(false);
    expect(expertInputSchema.safeParse({ ...base, preloadSkillKeys: ['voice'] }).success).toBe(
      false,
    );
  });
  it('validates team membership, lead and phase dependencies', () => {
    const member = { name: 'Editor', description: 'Role', instructions: 'Review', skillKeys: [] };
    const base = {
      ...member,
      expertType: 'team',
      team: {
        leadAgent: 'editor',
        members: [
          { ...member, agentId: 'editor' },
          { ...member, agentId: 'writer' },
        ],
        phases: [{ name: 'Draft', agents: ['writer'], task: 'Draft independently' }],
      },
    };
    expect(expertInputSchema.safeParse(base).success).toBe(true);
    expect(
      expertInputSchema.safeParse({ ...base, team: { ...base.team, leadAgent: 'missing' } })
        .success,
    ).toBe(false);
    expect(
      expertInputSchema.safeParse({
        ...base,
        team: { ...base.team, phases: [{ name: 'Self spawn', agents: ['editor'], task: 'No' }] },
      }).success,
    ).toBe(false);
    expect(expertInputSchema.safeParse({ ...base, expertType: 'agent' }).success).toBe(false);
  });
  it('validates references and bounded input', () => {
    expect(
      createRunSchema.safeParse({ accountId: 'bad', expertId: 'bad', topic: 'test' }).success,
    ).toBe(false);
    expect(
      accountInputSchema.safeParse({ name: '  ', platform: 'wechat', audience: 'a', persona: 'b' })
        .success,
    ).toBe(false);
  });
  it('does not treat running as a final result', () => {
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('waiting_user')).toBe(false);
  });
  it('bounds dynamic team commands and denies arbitrary capabilities', () => {
    expect(teamDirectiveSchema.parse({ action: 'ask_user', question: '  Reader type?  ' })).toEqual(
      { action: 'ask_user', question: 'Reader type?' },
    );
    for (const value of [
      { action: 'execute', command: 'shell' },
      { action: 'delegate', summary: 'Work', tasks: [] },
      {
        action: 'delegate',
        summary: 'Work',
        tasks: [{ memberId: 'writer', task: 'Write', dependencies: ['future'] }],
      },
      { action: 'request_peer', memberId: 'writer', question: 'Why', tools: ['shell'] },
      { action: 'ask_user', question: 'a'.repeat(2001) },
      { action: 'deliver', content: 'a'.repeat(100001) },
    ])
      expect(teamDirectiveSchema.safeParse(value).success).toBe(false);
    expect(teamResponseSchema.parse({ answer: '  Agreed  ', approved: false })).toEqual({
      answer: 'Agreed',
      approved: false,
    });
    for (const value of [
      { answer: ' ' },
      { answer: 'Ok', approved: 'true' },
      { answer: 'Ok', ownerId: 'other' },
      { answer: 'a'.repeat(2001) },
    ])
      expect(teamResponseSchema.safeParse(value).success).toBe(false);
  });
  it('accepts bounded plain-text documents and rejects executable or unknown nodes', () => {
    const output = {
      schemaVersion: 1,
      title: 'Draft',
      isMock: true,
      reviewStatus: 'pending_review',
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '<script>untrusted text</script>' }],
          },
        ],
      },
    };
    expect(runOutputSchema.safeParse(output).success).toBe(true);
    expect(runOutputSchema.safeParse({ ...output, isMock: false }).success).toBe(true);
    expect(runOutputSchema.safeParse({ ...output, isMock: 'false' }).success).toBe(false);
    expect(
      runOutputSchema.safeParse({
        ...output,
        document: {
          type: 'doc',
          content: [{ type: 'image', attrs: { src: 'javascript:alert(1)' } }],
        },
      }).success,
    ).toBe(false);
    expect(
      runOutputSchema.safeParse({
        ...output,
        document: {
          type: 'doc',
          content: [{ type: 'paragraph', attrs: { onclick: 'alert(1)' }, content: [] }],
        },
      }).success,
    ).toBe(false);
  });
});
