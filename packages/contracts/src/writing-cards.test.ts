import { describe, expect, it } from 'vitest';
import {
  accountInputSchema,
  localAssistantDraftSchema,
  writingCardsSchema,
  saveWritingCardsSchema,
} from './index';
const card = {
  id: '11111111-1111-4111-8111-111111111111',
  title: '人物卡',
  kind: 'persona' as const,
  content: '# 原文\r\n{{NAME_ab12cd34}}\n不要杜撰经历。',
  enabled: true,
};
describe('Account writing references', () => {
  it('preserves Markdown, line endings and literal placeholders without executing or rewriting', () => {
    expect(writingCardsSchema.parse([card])[0]!.content).toBe(card.content);
    expect(writingCardsSchema.safeParse([{ ...card, script: 'execute' }]).success).toBe(false);
  });
  it('bounds each reference, combined context including disabled cards, and unique identities', () => {
    expect(writingCardsSchema.safeParse([card, card]).success).toBe(false);
    expect(writingCardsSchema.safeParse([{ ...card, content: 'a'.repeat(8001) }]).success).toBe(
      false,
    );
    const many = Array.from({ length: 4 }, (_, i) => ({
      ...card,
      id: `11111111-1111-4111-8111-11111111111${i}`,
      content: '字'.repeat(8000),
      enabled: false,
    }));
    expect(writingCardsSchema.safeParse(many.slice(0, 3)).success).toBe(true);
    expect(writingCardsSchema.safeParse(many).success).toBe(false);
    expect(saveWritingCardsSchema.safeParse({ baseRevision: 0, writingCards: [] }).success).toBe(
      false,
    );
  });
  it('rejects blank text and controls while allowing tabs and ordinary newlines', () => {
    for (const content of ['', ' \n\t', 'x\u0000y', 'x\u001by'])
      expect(writingCardsSchema.safeParse([{ ...card, content }]).success).toBe(false);
    expect(writingCardsSchema.safeParse([{ ...card, content: '\tIndented\r\nText' }]).success).toBe(
      true,
    );
  });
  it('keeps old accounts and local conversation drafts compatible without opting into latest data', () => {
    const account = accountInputSchema.parse({
      name: 'Account',
      platform: 'wechat',
      audience: 'Readers',
      persona: 'Writer',
    });
    expect(account.writingCards).toBeUndefined();
    const draft = localAssistantDraftSchema.parse({
      mode: 'discuss',
      message: 'Hello',
      annotations: [],
      modelConnectionId: '',
      note: '',
    });
    expect(draft.accountProfileRevision).toBeUndefined();
  });
});
