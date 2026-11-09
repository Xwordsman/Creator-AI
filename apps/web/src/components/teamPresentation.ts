import type { AgentExecution, CreationRun, TeamAction, TeamMessage } from '@creator-ai/contracts';

export const agentRoleLabels: Record<AgentExecution['role'], string> = {
  agent: '独立专家',
  member: '团队成员',
  lead: '主理人汇总',
  planner: '主理人规划',
};
export const messageKindLabels: Record<TeamMessage['kind'], string> = {
  assignment: '任务委派',
  report: '成员汇报',
  question: '协作提问',
  answer: '协作答复',
  plan: '协作计划',
  confirmation: '确认记录',
};
export const directiveLabels: Record<TeamAction['directive']['action'], string> = {
  delegate: '执行计划',
  ask_user: '向你提问',
  confirm: '请你确认',
  finalize: '汇总安排',
  deliver: '内容交付',
  request_peer: '向成员请教',
};
export function participantName(run: CreationRun, id: string): string {
  const execution = run.execution?.agents.find((agent) => agent.id === id);
  const member = run.snapshot.expert.team?.members.find((agent) => agent.agentId === id);
  const agent = run.execution?.agents.find((item) => item.agentId === id);
  return execution?.name ?? member?.name ?? agent?.name ?? { user: '你', system: '系统' }[id] ?? id;
}
export function executionSource(run: CreationRun, id: string): string {
  const agent = run.execution?.agents.find((item) => item.id === id);
  return agent
    ? `${agent.name} · ${agentRoleLabels[agent.role]} · ${run.snapshot.workflow === 'team-dynamic-v1' ? '协作第' : '阶段'} ${agent.phase + 1}${run.snapshot.workflow === 'team-dynamic-v1' ? ' 轮' : ''}`
    : participantName(run, id);
}
export function isUserAction(action: TeamAction): boolean {
  return (
    action.state === 'waiting' &&
    !action.response &&
    ['delegate', 'ask_user', 'confirm'].includes(action.directive.action)
  );
}
