import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In, type EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  BUILTIN_SKILLS,
  expertSkillKeys,
  type Account,
  type AccountInput,
  type AccountDefaultExpertInput,
  type Expert,
  type ExpertInput,
  type PackageFile,
  type Skill,
  type SkillInput,
  type RestoreCapabilityInput,
  type SaveWritingCardsInput,
} from '@creator-ai/contracts';
import {
  AccountEntity,
  ExpertEntity,
  ExpertVersionEntity,
  SkillEntity,
  SkillVersionEntity,
} from '../../database/entities';
import { ApiError } from '../../common/http';
import { exportExpert, inspectPackage, parseSkill, skillDocument } from './package-codec';
import { readArchive, writeArchive } from './package-archive';

export const toAccount = (row: AccountEntity): Account => ({
  id: row.id,
  ...row.profile,
  revision: row.revision,
  defaultExpertId: row.defaultExpertId,
  createdAt: row.createdAt.toISOString(),
});
export const toExpert = (row: ExpertEntity): Expert => ({
  id: row.id,
  ...row.definition,
  version: row.version,
  enabled: row.enabled,
  hasSourcePackage: !!row.packageFiles,
  createdAt: row.createdAt.toISOString(),
});
export const toSkill = (row: SkillEntity): Skill => ({
  ...row.definition,
  version: row.version,
  enabled: row.enabled,
});

export async function resolveSkills(
  em: EntityManager,
  ownerId: string,
  keys: string[],
  versions: Record<string, number> = {},
  requireEnabled = true,
): Promise<Skill[]> {
  if (!keys.length) return [];
  const rows = await em.find(SkillEntity, {
    where: { ownerId, key: In(keys) },
    order: { key: 'ASC' },
    lock: { mode: 'pessimistic_read' },
  });
  const result: Skill[] = [];
  for (const key of keys) {
    const skill =
      BUILTIN_SKILLS.find((item) => item.key === key) ?? rows.find((row) => row.key === key);
    if (!skill || (requireEnabled && 'enabled' in skill && skill.enabled === false))
      throw new ApiError(422, 'SKILL_UNAVAILABLE', `技能不存在、已停用或无权访问：${key}`);
    let resolved =
      skill instanceof SkillEntity
        ? toSkill(skill)
        : { ...skill, source: 'builtin' as const, enabled: true };
    const pinned = versions[key];
    if (pinned !== undefined && pinned !== resolved.version) {
      const historical =
        skill instanceof SkillEntity
          ? await em.findOneBy(SkillVersionEntity, { skillId: skill.id, version: pinned })
          : null;
      if (!historical)
        throw new ApiError(
          422,
          'SKILL_VERSION_UNAVAILABLE',
          `技能历史版本不存在或无权访问：${key} · v${pinned}`,
        );
      resolved = { ...historical.definition, version: pinned, enabled: resolved.enabled };
    }
    result.push(resolved);
  }
  return result;
}

@Injectable()
export class CatalogService {
  constructor(@Inject(DataSource) private readonly db: DataSource) {}

  async listAccounts(ownerId: string, page: number, pageSize: number) {
    const [rows, total] = await this.db.getRepository(AccountEntity).findAndCount({
      where: { ownerId },
      order: { createdAt: 'DESC', id: 'ASC' },
      take: pageSize,
      skip: (page - 1) * pageSize,
    });
    return { items: rows.map(toAccount), total, page, pageSize };
  }
  async createAccount(ownerId: string, input: AccountInput) {
    const { defaultExpertId = null, ...profile } = input;
    return this.db.transaction(async (em) => {
      await this.checkDefaultExpert(em, ownerId, defaultExpertId);
      const row = await em.save(AccountEntity, {
        id: randomUUID(),
        ownerId,
        profile,
        defaultExpertId,
        revision: 1,
        createdAt: new Date(),
      });
      return toAccount(row);
    });
  }
  async getAccount(ownerId: string, id: string): Promise<Account> {
    const row = await this.db.getRepository(AccountEntity).findOneBy({ id, ownerId });
    if (!row) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '账号不存在。');
    return toAccount(row);
  }
  async saveWritingCards(ownerId: string, id: string, input: SaveWritingCardsInput) {
    return this.db.transaction(async (em) => {
      const row = await em.findOne(AccountEntity, {
        where: { id, ownerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '账号不存在。');
      if (row.revision !== input.baseRevision)
        throw new ApiError(
          409,
          'ACCOUNT_REVISION_CONFLICT',
          '账号配置已变化，请读取服务器资料后核对。',
        );
      row.profile = { ...row.profile, writingCards: input.writingCards };
      row.revision++;
      await em.save(row);
      return toAccount(row);
    });
  }
  private async checkDefaultExpert(em: EntityManager, ownerId: string, id: string | null) {
    if (!id) return;
    const expert = await em.findOne(ExpertEntity, {
      where: { id, ownerId },
      lock: { mode: 'pessimistic_read' },
    });
    if (!expert) throw new ApiError(404, 'EXPERT_NOT_FOUND', '专家不存在或无权访问。');
    if (!expert.enabled) throw new ApiError(422, 'EXPERT_DISABLED', '已停用的专家不能设置为默认。');
  }
  async setAccountDefault(ownerId: string, id: string, input: AccountDefaultExpertInput) {
    return this.db.transaction(async (em) => {
      const row = await em.findOne(AccountEntity, {
        where: { id, ownerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '账号不存在。');
      if (row.revision !== input.baseRevision)
        throw new ApiError(
          409,
          'ACCOUNT_REVISION_CONFLICT',
          '账号默认配置已变化，请重新读取后确认。',
        );
      await this.checkDefaultExpert(em, ownerId, input.expertId);
      if (row.defaultExpertId !== input.expertId) {
        row.defaultExpertId = input.expertId;
        row.revision++;
        await em.save(row);
      }
      return toAccount(row);
    });
  }
  async listExperts(ownerId: string, page: number, pageSize: number) {
    const [rows, total] = await this.db.getRepository(ExpertEntity).findAndCount({
      where: { ownerId },
      order: { createdAt: 'DESC', id: 'ASC' },
      take: pageSize,
      skip: (page - 1) * pageSize,
    });
    return { items: rows.map(toExpert), total, page, pageSize };
  }
  async createExpert(ownerId: string, definition: ExpertInput) {
    return this.db.transaction(async (em) => {
      await resolveSkills(em, ownerId, expertSkillKeys(definition), definition.skillVersions);
      return this.insertExpert(em, ownerId, definition);
    });
  }
  async updateExpert(ownerId: string, id: string, baseVersion: number, definition: ExpertInput) {
    return this.db.transaction(async (em) => {
      const row = await em.findOne(ExpertEntity, {
        where: { id, ownerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new ApiError(404, 'EXPERT_NOT_FOUND', '专家不存在。');
      if (row.version !== baseVersion)
        throw new ApiError(409, 'EXPERT_VERSION_CONFLICT', '专家已被修改，请刷新后重试。');
      await resolveSkills(em, ownerId, expertSkillKeys(definition), definition.skillVersions);
      row.version += 1;
      row.definition = definition;
      await em.save(row);
      await em.insert(ExpertVersionEntity, {
        expertId: id,
        version: row.version,
        restoredFrom: null,
        definition,
        packageFiles: row.packageFiles,
        createdAt: new Date(),
      });
      return toExpert(row);
    });
  }

  async restoreExpert(ownerId: string, id: string, input: RestoreCapabilityInput) {
    return this.db.transaction(async (em) => {
      const row = await em.findOne(ExpertEntity, {
        where: { id, ownerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new ApiError(404, 'EXPERT_NOT_FOUND', '专家不存在。');
      if (row.version !== input.baseVersion)
        throw new ApiError(
          409,
          'EXPERT_VERSION_CONFLICT',
          '专家版本已变化，请读取历史后重新确认。',
        );
      if (input.version === row.version)
        throw new ApiError(422, 'RESTORE_VERSION_CURRENT', '该版本已经是当前版本。');
      const source = await em.findOneBy(ExpertVersionEntity, {
        expertId: id,
        version: input.version,
      });
      if (!source) throw new ApiError(404, 'EXPERT_VERSION_NOT_FOUND', '专家历史版本不存在。');
      // Restoring configuration does not grant availability to disabled dependencies.
      await resolveSkills(
        em,
        ownerId,
        expertSkillKeys(source.definition),
        source.definition.skillVersions,
        false,
      );
      row.version++;
      row.definition = source.definition;
      row.packageFiles = source.packageFiles;
      await em.save(row);
      await em.insert(ExpertVersionEntity, {
        expertId: id,
        version: row.version,
        definition: row.definition,
        packageFiles: row.packageFiles,
        restoredFrom: input.version,
        createdAt: new Date(),
      });
      return toExpert(row);
    });
  }

  private async insertExpert(
    em: EntityManager,
    ownerId: string,
    definition: ExpertInput,
    packageFiles: PackageFile[] | null = null,
  ) {
    const row = await em.save(ExpertEntity, {
      id: randomUUID(),
      ownerId,
      definition,
      version: 1,
      enabled: true,
      packageFiles,
      createdAt: new Date(),
    });
    await em.insert(ExpertVersionEntity, {
      expertId: row.id,
      version: 1,
      definition,
      packageFiles,
      createdAt: row.createdAt,
    });
    return toExpert(row);
  }

  async expertVersions(ownerId: string, id: string, page: number, pageSize: number) {
    const expert = await this.db.getRepository(ExpertEntity).findOneBy({ id, ownerId });
    if (!expert) throw new ApiError(404, 'EXPERT_NOT_FOUND', '专家不存在。');
    const [rows, total] = await this.db.getRepository(ExpertVersionEntity).findAndCount({
      where: { expertId: id },
      order: { version: 'DESC' },
      take: pageSize,
      skip: (page - 1) * pageSize,
    });
    return {
      items: rows.map((row) => ({
        ...row.definition,
        id,
        version: row.version,
        restoredFrom: row.restoredFrom,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async setExpertEnabled(ownerId: string, id: string, enabled: boolean, baseVersion: number) {
    const result = await this.db
      .getRepository(ExpertEntity)
      .update({ id, ownerId, version: baseVersion }, { enabled });
    if (!result.affected)
      throw new ApiError(409, 'EXPERT_VERSION_CONFLICT', '专家不存在或版本已变化，请刷新。');
    return { enabled };
  }

  async listSkills(ownerId: string, page: number, pageSize: number) {
    const rows = await this.db
      .getRepository(SkillEntity)
      .find({ where: { ownerId }, order: { createdAt: 'DESC', key: 'ASC' } });
    const all = [
      ...BUILTIN_SKILLS.map((s): Skill => ({
        ...s,
        document: skillDocument(s),
        enabled: true,
        source: 'builtin',
      })),
      ...rows.map(toSkill),
    ];
    return {
      items: all.slice((page - 1) * pageSize, page * pageSize),
      total: all.length,
      page,
      pageSize,
    };
  }

  private async insertSkill(em: EntityManager, ownerId: string, skill: Skill) {
    // Serialize installs of the same owner/key before checking: imports never overwrite edits.
    await em.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${ownerId}:skill:${skill.key}`,
    ]);
    if (
      BUILTIN_SKILLS.some((s) => s.key === skill.key) ||
      (await em.existsBy(SkillEntity, { ownerId, key: skill.key }))
    )
      throw new ApiError(
        409,
        'SKILL_KEY_CONFLICT',
        `技能标识已存在：${skill.key}。请更新现有版本或使用新命名空间。`,
      );
    const row = await em.save(SkillEntity, {
      id: randomUUID(),
      ownerId,
      key: skill.key,
      version: 1,
      enabled: true,
      definition: skill,
      createdAt: new Date(),
    });
    await em.insert(SkillVersionEntity, {
      skillId: row.id,
      version: 1,
      definition: skill,
      createdAt: row.createdAt,
    });
    return toSkill(row);
  }

  async createSkill(ownerId: string, input: SkillInput) {
    const skill = parseSkill(input.key, input.document);
    return this.db.transaction((em) => this.insertSkill(em, ownerId, skill));
  }

  async updateSkill(ownerId: string, key: string, baseVersion: number, input: SkillInput) {
    if (input.key !== key)
      throw new ApiError(400, 'SKILL_KEY_IMMUTABLE', '更新版本不能改变技能标识。');
    return this.db.transaction(async (em) => {
      const row = await em.findOne(SkillEntity, {
        where: { ownerId, key },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new ApiError(404, 'SKILL_NOT_FOUND', '技能不存在；内置技能请先复制。');
      if (row.version !== baseVersion)
        throw new ApiError(409, 'SKILL_VERSION_CONFLICT', '技能版本已变化，请刷新。');
      row.version++;
      row.definition = {
        ...parseSkill(key, input.document, row.definition.files),
        version: row.version,
        source: row.definition.source,
      };
      await em.save(row);
      await em.insert(SkillVersionEntity, {
        skillId: row.id,
        version: row.version,
        definition: row.definition,
        createdAt: new Date(),
      });
      return toSkill(row);
    });
  }

  async skillVersions(ownerId: string, key: string, page: number, pageSize: number) {
    const row = await this.db.getRepository(SkillEntity).findOneBy({ ownerId, key });
    if (!row) throw new ApiError(404, 'SKILL_NOT_FOUND', '自定义技能不存在。');
    const [versions, total] = await this.db.getRepository(SkillVersionEntity).findAndCount({
      where: { skillId: row.id },
      order: { version: 'DESC' },
      take: pageSize,
      skip: (page - 1) * pageSize,
    });
    return {
      items: versions.map((v) => ({
        ...v.definition,
        version: v.version,
        createdAt: v.createdAt.toISOString(),
        restoredFrom: v.restoredFrom,
      })),
      total,
      page,
      pageSize,
    };
  }

  async restoreSkill(ownerId: string, key: string, input: RestoreCapabilityInput) {
    return this.db.transaction(async (em) => {
      const row = await em.findOne(SkillEntity, {
        where: { ownerId, key },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new ApiError(404, 'SKILL_NOT_FOUND', '自定义技能不存在；内置技能不可恢复。');
      if (row.version !== input.baseVersion)
        throw new ApiError(409, 'SKILL_VERSION_CONFLICT', '技能版本已变化，请读取历史后重新确认。');
      if (input.version === row.version)
        throw new ApiError(422, 'RESTORE_VERSION_CURRENT', '该版本已经是当前版本。');
      const source = await em.findOneBy(SkillVersionEntity, {
        skillId: row.id,
        version: input.version,
      });
      if (!source) throw new ApiError(404, 'SKILL_VERSION_NOT_FOUND', '技能历史版本不存在。');
      row.version++;
      row.definition = { ...source.definition, version: row.version };
      await em.save(row);
      await em.insert(SkillVersionEntity, {
        skillId: row.id,
        version: row.version,
        definition: row.definition,
        restoredFrom: input.version,
        createdAt: new Date(),
      });
      return toSkill(row);
    });
  }

  async setSkillEnabled(ownerId: string, key: string, enabled: boolean, baseVersion: number) {
    const result = await this.db
      .getRepository(SkillEntity)
      .update({ ownerId, key, version: baseVersion }, { enabled });
    if (!result.affected)
      throw new ApiError(409, 'SKILL_VERSION_CONFLICT', '技能不存在、为内置技能或版本已变化。');
    return { enabled };
  }

  async previewPackage(buffer: Buffer) {
    return inspectPackage(await readArchive(buffer));
  }

  async importPackage(ownerId: string, buffer: Buffer) {
    const preview = await this.previewPackage(buffer);
    return this.db.transaction(async (em) => {
      const skills: Skill[] = [];
      for (const skill of [...preview.skills].sort((a, b) => a.key.localeCompare(b.key)))
        skills.push(await this.insertSkill(em, ownerId, { ...skill, source: 'imported' }));
      const expert = preview.expert
        ? await this.insertExpert(em, ownerId, preview.expert, preview.files)
        : null;
      return { expert, skills, warnings: preview.warnings };
    });
  }

  async exportSkill(ownerId: string, key: string) {
    // Disabled packages can still be backed up, but cannot be selected for new runs.
    const builtin = BUILTIN_SKILLS.find((s) => s.key === key);
    const row = await this.db.getRepository(SkillEntity).findOneBy({ ownerId, key });
    const skill = builtin ?? (row ? toSkill(row) : null);
    if (!skill) throw new ApiError(404, 'SKILL_NOT_FOUND', '技能不存在。');
    return writeArchive([
      { path: 'SKILL.md', content: skillDocument(skill), encoding: 'utf8' },
      ...(skill.files ?? []),
    ]);
  }

  async exportExpert(ownerId: string, id: string, original: boolean) {
    const row = await this.db.getRepository(ExpertEntity).findOneBy({ ownerId, id });
    if (!row) throw new ApiError(404, 'EXPERT_NOT_FOUND', '专家不存在。');
    if (original) {
      if (!row.packageFiles)
        throw new ApiError(404, 'SOURCE_PACKAGE_NOT_FOUND', '此专家没有原始导入包。');
      return writeArchive(row.packageFiles);
    }
    const skills = await this.db.transaction((em) =>
      resolveSkills(
        em,
        ownerId,
        expertSkillKeys(row.definition),
        row.definition.skillVersions,
        false,
      ),
    );
    const files = exportExpert(row.definition, skills, `expert-${id}`, row.version);
    const attachments = (row.packageFiles ?? []).filter(
      (file) =>
        !/^(agents|skills|\.codebuddy-plugin)\//.test(file.path) && file.path !== 'settings.json',
    );
    return writeArchive([...files, ...attachments]);
  }
}
