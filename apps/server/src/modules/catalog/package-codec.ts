import { parseDocument, stringify } from 'yaml';
import {
  agentDefinitionSchema,
  expertInputSchema,
  skillKeySchema,
  type AgentDefinition,
  type ExpertInput,
  type PackageFile,
  type PackagePreview,
  type Skill,
} from '@creator-ai/contracts';
import { invalidPackage, safePackagePath } from './package-archive';

type Metadata = Record<string, unknown>;
const record = (value: unknown): Metadata => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalidPackage('元数据必须是一个对象。');
  return value as Metadata;
};
const text = (value: unknown, max = 20000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    invalidPackage('包缺少有效的名称、描述、指令或路径。');
  return value.trim();
};
const localized = (value: unknown, fallback: string): string => {
  if (value === undefined) return fallback;
  if (typeof value === 'string') return text(value);
  const item = record(value);
  return text(item.zh ?? item.en);
};
const strings = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32)
    invalidPackage('资源和技能声明必须是有限的字符串数组。');
  return value.map((item) => text(item, 240));
};
const resourcePath = (value: string) => safePackagePath(value.replace(/^\.\//, ''));

export function parseMarkdown(document: string) {
  if (document.length > 40000) invalidPackage('Markdown 定义超过长度限制。');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(document);
  if (!match) invalidPackage('需要 YAML frontmatter（---）和非空 Markdown 正文。');
  try {
    const parsed = parseDocument(match[1]!, { uniqueKeys: true, schema: 'core' });
    if (parsed.errors.length) invalidPackage('YAML 无效，不能包含重复字段。');
    return { metadata: record(parsed.toJS({ maxAliasCount: 0 })), instructions: text(match[2]) };
  } catch {
    invalidPackage('YAML 无效或包含不支持的别名。');
  }
}

export function skillDocument(skill: Skill): string {
  return (
    skill.document ??
    `---\n${stringify({ name: skill.key.split(':').at(-1), description: skill.description })}---\n\n${skill.instructions}\n`
  );
}

export function parseSkill(key: string, document: string, files: PackageFile[] = []): Skill {
  if (!skillKeySchema.safeParse(key).success)
    invalidPackage('技能标识应为小写英文、数字和连字符，可包含一个命名空间。');
  const { metadata, instructions } = parseMarkdown(document);
  const name = text(metadata.name, 80);
  if (name !== key.split(':').at(-1)) invalidPackage('SKILL.md 的 name 必须与技能标识末段一致。');
  const warnings: string[] = [];
  if (Object.keys(metadata).some((field) => !['name', 'description'].includes(field)))
    warnings.push('额外 YAML 字段已保留，但不授予工具权限，也不保证其运行时语义。');
  if (files.some((file) => /(^|\/)(scripts|bin)\//.test(file.path)))
    warnings.push('包含脚本或二进制目录：仅保存，不安装依赖、不执行。');
  return {
    key,
    version: 1,
    name,
    description: text(metadata.description, 1000),
    instructions,
    allowedTools: [],
    document,
    files,
    enabled: true,
    source: 'custom',
    warnings,
  };
}

function readText(files: PackageFile[], path: string): string {
  const file = files.find((item) => item.path === path);
  if (!file || file.encoding !== 'utf8') invalidPackage(`缺少 UTF-8 文本文件：${path}`);
  return file.content;
}
function readJson(files: PackageFile[], path: string): Metadata {
  try {
    return record(JSON.parse(readText(files, path)));
  } catch {
    invalidPackage(`JSON 无效或文件缺失：${path}`);
  }
}
function stripWrapper(files: PackageFile[]): PackageFile[] {
  if (
    files.some((file) => file.path === 'SKILL.md' || file.path === '.codebuddy-plugin/plugin.json')
  )
    return files;
  const roots = new Set(files.map((file) => file.path.split('/')[0]));
  if (roots.size !== 1 || files.some((file) => !file.path.includes('/'))) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(file.path.indexOf('/') + 1) }));
}

export function inspectPackage(input: PackageFile[]): PackagePreview {
  const files = stripWrapper(input);
  const warnings = [
    '仅完成包格式解析与资源保存；尚未验证此包的模型质量、工具依赖或第三方运行兼容性。',
  ];
  if (!files.some((file) => file.path === '.codebuddy-plugin/plugin.json')) {
    const document = readText(files, 'SKILL.md');
    const { metadata } = parseMarkdown(document);
    const skill = parseSkill(
      text(metadata.name, 80),
      document,
      files.filter((file) => file.path !== 'SKILL.md'),
    );
    return {
      kind: 'skill',
      name: skill.name,
      packageVersion: null,
      skills: [skill],
      files,
      warnings: [...warnings, ...(skill.warnings ?? [])],
      runtimeReady: false,
    };
  }
  const manifest = readJson(files, '.codebuddy-plugin/plugin.json');
  const packageName = text(manifest.name, 80);
  if (!skillKeySchema.safeParse(packageName).success || packageName.includes(':'))
    invalidPackage('专家包名称无效。');
  const packageVersion = text(manifest.version, 80);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageVersion))
    invalidPackage('包版本必须是语义化版本。');
  const description = text(manifest.description, 1000);
  if (!['agent', 'team'].includes(String(manifest.expertType)))
    invalidPackage('expertType 必须是 agent 或 team。');
  const skills = strings(manifest.skills).map((path) => {
    const directory = resourcePath(path);
    const document = readText(files, `${directory}/SKILL.md`);
    const name = text(parseMarkdown(document).metadata.name, 80);
    const resources = files
      .filter(
        (file) => file.path.startsWith(`${directory}/`) && file.path !== `${directory}/SKILL.md`,
      )
      .map((file) => ({ ...file, path: file.path.slice(directory.length + 1) }));
    const skill = parseSkill(`${packageName}:${name}`, document, resources);
    skill.source = 'imported';
    warnings.push(...(skill.warnings ?? []));
    return skill;
  });
  if (new Set(skills.map((s) => s.key)).size !== skills.length)
    invalidPackage('包内技能名称重复。');
  const available = skills.map((s) => s.key);
  const extension = manifest.creatorAi === undefined ? {} : record(manifest.creatorAi);
  const pinned = strings(extension.pinnedSkills).map((name) => `${packageName}:${name}`);
  if (new Set(pinned).size !== pinned.length || pinned.some((key) => !available.includes(key)))
    invalidPackage('固定版本绑定必须指向包内唯一技能。');
  if (pinned.length)
    warnings.push('包内技能安装为新的 v1；固定绑定重定位到随包保存的 v1，不保留来源库的版本编号。');
  const agentSkills = extension.agentSkills === undefined ? {} : record(extension.agentSkills);
  const agents = strings(manifest.agents).map((path): AgentDefinition => {
    const resolved = resourcePath(path);
    if (!/^agents\/[a-z][a-z0-9-]*\.md$/.test(resolved))
      invalidPackage('Agent 应放在 agents/<id>.md。');
    const { metadata, instructions } = parseMarkdown(readText(files, resolved));
    const agentId = resolved.slice(7, -3);
    if (metadata.name !== agentId || 'tools' in metadata)
      invalidPackage('Agent name 必须匹配文件名，且不能声明 tools。');
    const preloads = strings(metadata.skills).map((name) =>
      name.includes(':') ? name : `${packageName}:${name}`,
    );
    const scopedSkills =
      agentSkills[agentId] === undefined
        ? available
        : strings(agentSkills[agentId]).map((name) => `${packageName}:${name}`);
    if (
      scopedSkills.some((key) => !available.includes(key)) ||
      preloads.some((key) => !scopedSkills.includes(key))
    )
      invalidPackage('Agent 引用了包内未提供或未授权的技能。');
    const parsed = agentDefinitionSchema.safeParse({
      agentId,
      name: localized(metadata.displayName, agentId),
      description: text(metadata.description, 1000),
      profession:
        metadata.profession === undefined ? undefined : localized(metadata.profession, ''),
      instructions,
      skillKeys: scopedSkills,
      preloadSkillKeys: preloads,
      maxTurns: metadata.maxTurns ?? 50,
    });
    if (!parsed.success) invalidPackage('Agent 字段格式或长度不符合要求。');
    if (
      Object.keys(metadata).some(
        (field) =>
          !['name', 'description', 'displayName', 'profession', 'maxTurns', 'skills'].includes(
            field,
          ),
      )
    )
      warnings.push(`Agent ${agentId} 的额外字段已存档，尚不解释其语义。`);
    return parsed.data;
  });
  if (!agents.length || new Set(agents.map((a) => a.agentId)).size !== agents.length)
    invalidPackage('Agent 列表为空或重复。');
  const lead = agents.find((agent) => agent.agentId === manifest.agentName);
  if (!lead) invalidPackage('agentName 未指向包内 Agent。');
  let team: ExpertInput['team'];
  if (manifest.expertType === 'team') {
    const info = record(manifest.teamInfo);
    const members = strings(info.memberAgents);
    if (
      info.leadAgent !== lead.agentId ||
      members.includes(lead.agentId) ||
      new Set(members).size !== members.length ||
      members.length !== agents.length - 1 ||
      members.some((id) => !agents.some((agent) => agent.agentId === id))
    )
      invalidPackage('主理人和成员声明不一致，memberAgents 不应包含主理人。');
    if (readJson(files, 'settings.json').agent !== lead.agentId)
      invalidPackage('settings.json 必须指向主理人。');
    if (!Array.isArray(manifest.members) || manifest.members.length !== agents.length)
      invalidPackage('专家团缺少完整 members 展示清单。');
    const memberIds = new Set<string>();
    for (const item of manifest.members) {
      const member = record(item);
      const id = text(member.id, 80);
      if (
        memberIds.has(id) ||
        !agents.some((agent) => agent.agentId === id) ||
        member.role !== (id === lead.agentId ? 'lead' : 'member')
      )
        invalidPackage('members 清单中的成员或角色不一致。');
      memberIds.add(id);
    }
    team = { leadAgent: lead.agentId, members: agents };
    if (extension.phases !== undefined)
      team.phases = extension.phases as NonNullable<ExpertInput['team']>['phases'];
    warnings.push('专家团已解析为独立角色；SOP 不会自动被当作已授权的执行步骤。');
  } else if (agents.length !== 1)
    invalidPackage('单专家包应只有一个 Agent；多 Agent 请使用 team。');
  const localizedList = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) invalidPackage('标签和推荐问法应为数组。');
    return value.map((item) => localized(item, ''));
  };
  const expert = expertInputSchema.safeParse({
    name: localized(manifest.displayName, packageName),
    description: localized(manifest.displayDescription, description),
    instructions:
      extension.instructions === undefined ? lead.instructions : text(extension.instructions),
    expertType: manifest.expertType,
    agentId: lead.agentId,
    profession: localized(manifest.profession, lead.profession ?? ''),
    maxTurns: lead.maxTurns,
    skillKeys: available,
    ...(pinned.length ? { skillVersions: Object.fromEntries(pinned.map((key) => [key, 1])) } : {}),
    preloadSkillKeys:
      extension.preloads === undefined
        ? lead.preloadSkillKeys
        : strings(extension.preloads).map((name) => `${packageName}:${name}`),
    quickPrompts: localizedList(manifest.quickPrompts),
    defaultInitPrompt: localized(manifest.defaultInitPrompt, ''),
    tags: localizedList(manifest.tags),
    team,
  });
  if (!expert.success) invalidPackage('专家或团队定义无效，请检查成员、阶段、字段长度和技能引用。');
  if (files.some((file) => /(^|\/)(scripts|bin)\//.test(file.path)))
    warnings.push('包含脚本/工具资源：保持惰性存储，不执行或安装。');
  warnings.push('头像、扩展清单字段和附带资源原样存档；桌面/MCP/私有工具依赖没有自动适配。');
  return {
    kind: 'expert',
    name: expert.data.name,
    packageVersion,
    expert: expert.data,
    skills,
    files,
    warnings: [...new Set(warnings)],
    runtimeReady: false,
  };
}

export function exportExpert(
  expert: ExpertInput,
  skills: Skill[],
  packageName: string,
  version: number,
): PackageFile[] {
  const agents: AgentDefinition[] = expert.team?.members ?? [
    {
      agentId: expert.agentId ?? 'content-expert',
      name: expert.name,
      description: expert.description,
      instructions: expert.instructions,
      profession: expert.profession,
      maxTurns: expert.maxTurns,
      skillKeys: expert.skillKeys,
      preloadSkillKeys: expert.preloadSkillKeys,
    },
  ];
  // Export aliases avoid collisions between equal local names in different namespaces.
  const localNames = skills.map((skill) => skill.key.split(':').at(-1)!);
  const used = new Set(localNames);
  const aliases = new Map<string, string>();
  for (const skill of skills) {
    const name = skill.key.split(':').at(-1)!;
    let alias = name;
    if (localNames.filter((item) => item === name).length > 1) {
      let suffix = 1;
      do {
        alias = `${name.slice(0, 60)}-${suffix++}`;
      } while (used.has(alias));
      used.add(alias);
    }
    aliases.set(skill.key, alias);
  }
  const files: PackageFile[] = [];
  const add = (path: string, content: string) => files.push({ path, content, encoding: 'utf8' });
  for (const agent of agents)
    add(
      `agents/${agent.agentId}.md`,
      `---\n${stringify({
        name: agent.agentId,
        description: agent.description,
        displayName: agent.name,
        profession: agent.profession || undefined,
        maxTurns: agent.maxTurns ?? 50,
        skills: (agent.preloadSkillKeys ?? []).map((key) => aliases.get(key)),
      })}---\n\n${agent.instructions}\n`,
    );
  for (const skill of skills) {
    const alias = aliases.get(skill.key)!;
    const { metadata, instructions } = parseMarkdown(skillDocument(skill));
    add(
      `skills/${alias}/SKILL.md`,
      `---\n${stringify({ ...metadata, name: alias })}---\n\n${instructions}\n`,
    );
    for (const file of skill.files ?? [])
      files.push({ ...file, path: `skills/${alias}/${file.path}` });
  }
  const lead = expert.team?.leadAgent ?? agents[0]!.agentId;
  add(
    '.codebuddy-plugin/plugin.json',
    JSON.stringify(
      {
        name: packageName,
        version: `1.0.${version}`,
        description: expert.description,
        expertType: expert.expertType ?? 'agent',
        agentName: lead,
        agents: agents.map((agent) => `./agents/${agent.agentId}.md`),
        skills: [...aliases.values()].map((name) => `./skills/${name}`),
        displayName: { zh: expert.name, en: expert.name },
        profession: expert.profession || undefined,
        quickPrompts: expert.quickPrompts,
        defaultInitPrompt: expert.defaultInitPrompt || undefined,
        tags: expert.tags,
        creatorAi: {
          instructions: expert.instructions,
          phases: expert.team?.phases,
          preloads: (expert.preloadSkillKeys ?? []).map((key) => aliases.get(key)),
          agentSkills: Object.fromEntries(
            agents.map((agent) => [agent.agentId, agent.skillKeys.map((key) => aliases.get(key))]),
          ),
          pinnedSkills: Object.keys(expert.skillVersions ?? {}).map((key) => aliases.get(key)),
          sourceSkillVersions: Object.fromEntries(
            skills.map((skill) => [aliases.get(skill.key), skill.version]),
          ),
        },
        ...(expert.team
          ? {
              teamInfo: {
                leadAgent: lead,
                memberAgents: agents.filter((a) => a.agentId !== lead).map((a) => a.agentId),
              },
              members: agents.map((a) => ({
                id: a.agentId,
                name: { zh: a.name, en: a.name },
                profession: a.profession,
                role: a.agentId === lead ? 'lead' : 'member',
              })),
            }
          : {}),
      },
      null,
      2,
    ),
  );
  if (expert.team) add('settings.json', JSON.stringify({ agent: lead }));
  return files;
}
