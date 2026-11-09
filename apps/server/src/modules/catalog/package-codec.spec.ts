import type { ExpertInput, PackageFile } from '@creator-ai/contracts';
import { ZipFile } from 'yazl';
import { exportExpert, inspectPackage, parseMarkdown, parseSkill } from './package-codec';
import { readArchive, safePackagePath, writeArchive } from './package-archive';

const document =
  '---\nname: original-skill\ndescription: Use for a concise draft\n---\n\nWrite an original concise draft.\n';
const file = (path: string, content: string): PackageFile => ({ path, content, encoding: 'utf8' });
const expert: ExpertInput = {
  name: 'Original editor',
  description: 'An independent fixture',
  instructions: 'Produce a draft',
  skillKeys: [],
};
async function uncheckedZip(files: PackageFile[]): Promise<Buffer> {
  const zip = new ZipFile();
  for (const item of files) zip.addBuffer(Buffer.from(item.content, item.encoding), item.path);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('capability packages (original fixtures, no vendor content)', () => {
  it('parses metadata without running scripts or treating tools as grants', () => {
    const skill = parseSkill(
      'my-pack:original-skill',
      document.replace('description:', 'allowed-tools: [shell]\ndescription:'),
      [file('scripts/helper.py', 'raise Exception("must never run")')],
    );
    expect(skill.allowedTools).toEqual([]);
    expect(skill.warnings).toHaveLength(2);
    expect(skill.files).toHaveLength(1);
  });
  it.each([
    'No header',
    '---\nname: a\nname: b\n---\nbody',
    '---\nname: &a text\ndescription: *a\n---\nbody',
  ])('rejects malformed or aliased YAML: %s', (input) => {
    expect(() => parseMarkdown(input)).toThrow();
  });
  it('rejects invalid names, blank description, and mismatched identifiers', () => {
    expect(() => parseSkill('other', document)).toThrow();
    expect(() =>
      parseSkill('original-skill', document.replace('Use for a concise draft', '')),
    ).toThrow();
  });
  it('accepts a wrapped skill ZIP with resources and roundtrips binary bytes', async () => {
    const zip = await writeArchive([
      file('wrapped/SKILL.md', document),
      file('wrapped/references/style.md', 'Use short sentences.'),
      { path: 'wrapped/assets/sample.bin', content: 'AP8B', encoding: 'base64' },
    ]);
    const preview = inspectPackage(await readArchive(zip));
    expect(preview.skills[0]?.files).toHaveLength(2);
    expect(preview.skills[0]?.files?.[1]?.content).toBe('AP8B');
    expect(preview.runtimeReady).toBe(false);
  });
  it.each([
    '../outside',
    '/etc/passwd',
    'C:/file',
    'a\\b',
    'a/../b',
    'a//b',
    'a/./b',
    'a\0b',
    'file.',
  ])('rejects unsafe archive paths %s', (path) => {
    expect(() => safePackagePath(path)).toThrow();
  });
  it('rejects case-insensitive duplicate ZIP paths', async () => {
    const zip = await uncheckedZip([file('SKILL.md', document), file('skill.md', document)]);
    await expect(readArchive(zip)).rejects.toThrow();
    await expect(writeArchive([file('a', 'x'), file('A', 'x')])).rejects.toThrow();
  });
  it('limits expanded data and entry count before accepting a ZIP', async () => {
    await expect(
      readArchive(await uncheckedZip([file('huge.txt', 'x'.repeat(512 * 1024 + 1))])),
    ).rejects.toThrow();
    await expect(
      readArchive(
        await uncheckedZip(Array.from({ length: 129 }, (_, i) => file(`f-${i}.txt`, 'x'))),
      ),
    ).rejects.toThrow();
    await expect(writeArchive([file('huge.txt', 'x'.repeat(512 * 1024 + 1))])).rejects.toThrow();
    await expect(readArchive(Buffer.from('not a zip'))).rejects.toThrow();
  });
  it('roundtrips skill-free expert packages', async () => {
    const preview = inspectPackage(
      await readArchive(await writeArchive(exportExpert(expert, [], 'original-pack', 3))),
    );
    expect(preview.expert).toMatchObject({
      name: expert.name,
      instructions: expert.instructions,
      skillKeys: [],
      expertType: 'agent',
    });
    expect(preview.packageVersion).toBe('1.0.3');
  });
  it('exports pinned bytes and rebases pinned bindings to the installed package v1', () => {
    const skill = {
      ...parseSkill('original-skill', document, [
        file('references/version.md', 'Historical v7 resource'),
      ]),
      version: 7,
    };
    const files = exportExpert(
      { ...expert, skillKeys: [skill.key], skillVersions: { [skill.key]: 7 } },
      [skill],
      'pinned-pack',
      4,
    );
    const manifest = JSON.parse(
      files.find((f) => f.path === '.codebuddy-plugin/plugin.json')!.content,
    );
    expect(manifest.creatorAi.sourceSkillVersions).toEqual({ 'original-skill': 7 });
    const preview = inspectPackage(files);
    expect(preview.expert?.skillVersions).toEqual({ 'pinned-pack:original-skill': 1 });
    expect(preview.skills[0]?.files?.[0]?.content).toBe('Historical v7 resource');
    expect(preview.warnings.some((warning) => warning.includes('v1'))).toBe(true);
    manifest.creatorAi.pinnedSkills = ['missing'];
    files.find((f) => f.path === '.codebuddy-plugin/plugin.json')!.content =
      JSON.stringify(manifest);
    expect(() => inspectPackage(files)).toThrow();
  });
  it('roundtrips a team with independent members, scoped skills and phases', () => {
    const skill = parseSkill('original-skill', document);
    const team: ExpertInput = {
      ...expert,
      expertType: 'team',
      skillKeys: ['original-skill'],
      quickPrompts: ['Draft an article'],
      team: {
        leadAgent: 'editor',
        members: [
          { ...expert, agentId: 'editor', skillKeys: [] },
          {
            ...expert,
            agentId: 'writer',
            skillKeys: ['original-skill'],
            preloadSkillKeys: ['original-skill'],
            instructions: 'Write independently',
          },
        ],
        phases: [
          { name: 'Draft', agents: ['writer'], task: 'Write a draft, then report to the editor' },
        ],
      },
    };
    const preview = inspectPackage(exportExpert(team, [skill], 'original-team', 1));
    expect(preview.expert?.team?.members[0]?.skillKeys).toEqual([]);
    expect(preview.expert?.team?.members[1]?.preloadSkillKeys).toEqual([
      'original-team:original-skill',
    ]);
    expect(preview.expert?.team?.phases).toEqual(team.team?.phases);
    expect(preview.expert?.instructions).toBe(team.instructions);
  });
  it('rejects missing resources and attempts to grant agent tools', () => {
    const files = exportExpert(expert, [], 'original-pack', 1);
    expect(() => inspectPackage(files.filter((f) => !f.path.startsWith('agents/')))).toThrow();
    const agent = files.find((f) => f.path.startsWith('agents/'))!;
    agent.content = agent.content.replace('name:', 'tools: [shell]\nname:');
    expect(() => inspectPackage(files)).toThrow();
  });
  it('reserves original skill names before assigning export aliases', () => {
    const skills = [
      parseSkill('one:original-skill', document),
      parseSkill('two:original-skill', document),
      parseSkill(
        'original-skill-1',
        document.replace('name: original-skill', 'name: original-skill-1'),
      ),
    ];
    const preview = inspectPackage(
      exportExpert({ ...expert, skillKeys: skills.map((s) => s.key) }, skills, 'aliases', 1),
    );
    expect(new Set(preview.skills.map((s) => s.key)).size).toBe(3);
    expect(preview.skills.map((s) => s.key)).toContain('aliases:original-skill-1');
  });
});
