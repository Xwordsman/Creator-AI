import type { DocumentNode, RunOutput, RunSnapshot } from '@creator-ai/contracts';

export interface TextProvider {
  generate(snapshot: RunSnapshot): Promise<unknown>;
}
const paragraph = (text: string): DocumentNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const heading = (text: string): DocumentNode => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [{ type: 'text', text }],
});

export class MockTextProvider implements TextProvider {
  async generate(snapshot: RunSnapshot): Promise<RunOutput> {
    if (
      snapshot.provider === 'mock' &&
      snapshot.workflow === 'content-assist-v1' &&
      snapshot.assistance
    ) {
      return {
        schemaVersion: 1,
        title: snapshot.assistance.title,
        document: snapshot.assistance.document,
        isMock: true,
        reviewStatus: 'pending_review',
        assistance: {
          reply:
            '【模拟回复】本轮已保存当前稿、要求和批注，但未调用 AI，未分析或改写正文。请选择已配置的真实模型体验讨论与修改建议。',
          suggestions: [],
        },
      };
    }
    if (snapshot.provider !== 'mock' || snapshot.workflow !== 'mock-article-v1')
      throw new Error('Unsupported provider');
    if (snapshot.expert.expertType === 'team')
      throw new Error('Team execution requires an independent agent runtime');
    // Deliberately deterministic: this tests context persistence, not actual model reasoning.
    return {
      schemaVersion: 1,
      title: snapshot.topic,
      isMock: true,
      reviewStatus: 'pending_review',
      document: {
        type: 'doc',
        content: [
          paragraph(
            '【模拟草稿】此内容由本地模板生成，未调用 AI，不代表真实创作质量，请勿直接发布。',
          ),
          ...(snapshot.continuation
            ? [
                heading('继续创作 / 流程验证'),
                paragraph(
                  `基于草稿 ${snapshot.continuation.parentRunId}，分支深度 ${snapshot.continuation.depth}。`,
                ),
                paragraph(`本轮修改要求：${snapshot.continuation.instruction}`),
                paragraph(
                  `原稿标题：${snapshot.continuation.previousOutput.title}。原稿全文已保存在本次上下文中，可返回来源查看。此模板未理解或改写原稿，不代表修改已完成。`,
                ),
              ]
            : []),
          heading('01 / 先明确读者的问题'),
          paragraph(`本次主题：${snapshot.topic}。目标读者：${snapshot.account.audience}。`),
          paragraph(`账号「${snapshot.account.name}」的表达约束：${snapshot.account.persona}`),
          heading('02 / 让专家复用你的方法'),
          paragraph(`当前专家：${snapshot.expert.name}，版本 v${snapshot.expert.version}。`),
          paragraph(`保存的工作指令：${snapshot.expert.instructions}`),
          paragraph(
            `绑定技能：${snapshot.skills.map((skill) => `${skill.name} v${skill.version}`).join('、')}。这里只展示绑定快照，未执行真实技能推理。`,
          ),
          ...(snapshot.brief ? [paragraph(`本次补充要求：${snapshot.brief}`)] : []),
          heading('03 / 发布前，留一道人工检查'),
          paragraph(
            '请补充真实案例与可靠来源，核实事实、数据和素材授权。这份模拟草稿只用于验证任务、专家快照与后台执行流程。',
          ),
        ],
      },
    };
  }
}
