import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import {
  runOutputSchema,
  type ContentDetail,
  type ContentItem,
  type ContentReview,
  type ContentVersion,
  type ExportContentInput,
  type Page,
  type RestoreContentInput,
  type ReviewContentInput,
  type SaveContentInput,
} from '@creator-ai/contracts';
import { ApiError } from '../../common/http';
import { RunEntity } from '../../database/entities';
import { hashToken } from '../auth/credentials';
import { renderContentExport } from './content-export';

interface ItemRow {
  id: string;
  source_run_id: string;
  account_name: string;
  platform: string;
  is_mock: boolean;
  title: string;
  status: ContentItem['status'];
  current_version: number;
  revision: number;
  created_at: Date;
  updated_at: Date;
}
interface VersionRow {
  version: number;
  title: string;
  document: ContentVersion['document'];
  kind: ContentVersion['kind'];
  restored_from: number | null;
  note: string;
  created_at: Date;
}
const toItem = (r: ItemRow): ContentItem => ({
  id: r.id,
  sourceRunId: r.source_run_id,
  accountName: r.account_name,
  platform: r.platform,
  isMock: r.is_mock,
  title: r.title,
  status: r.status,
  currentVersion: r.current_version,
  revision: r.revision,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
const toVersion = (r: VersionRow): ContentVersion => ({
  version: r.version,
  title: r.title,
  document: r.document,
  kind: r.kind,
  restoredFrom: r.restored_from,
  note: r.note,
  createdAt: r.created_at.toISOString(),
});

@Injectable()
export class ContentService {
  constructor(@Inject(DataSource) private readonly db: DataSource) {}

  private async owned(em: EntityManager, ownerId: string, id: string, lock = false) {
    const [row] = await em.query<ItemRow[]>(
      `SELECT * FROM content_items WHERE id=$1 AND owner_id=$2${lock ? ' FOR UPDATE' : ''}`,
      [id, ownerId],
    );
    if (!row) throw new ApiError(404, 'CONTENT_NOT_FOUND', '内容不存在。');
    return row;
  }
  private async version(em: EntityManager, id: string, version: number) {
    const [row] = await em.query<VersionRow[]>(
      'SELECT * FROM content_versions WHERE content_id=$1 AND version=$2',
      [id, version],
    );
    if (!row) throw new ApiError(404, 'VERSION_NOT_FOUND', '内容版本不存在。');
    return toVersion(row);
  }
  private async detail(em: EntityManager, row: ItemRow): Promise<ContentDetail> {
    return { item: toItem(row), version: await this.version(em, row.id, row.current_version) };
  }

  async promote(ownerId: string, runId: string): Promise<ContentDetail> {
    return this.db.transaction(async (em) => {
      // The source run is the natural idempotency key, including concurrent imports.
      const run = await em.findOne(RunEntity, {
        where: { id: runId, ownerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!run) throw new ApiError(404, 'RUN_NOT_FOUND', '任务不存在。');
      if (run.snapshot.assistance)
        throw new ApiError(
          422,
          'ASSISTANCE_NOT_ARTICLE',
          '协作建议不是新文章，请返回原稿选择应用。',
        );
      const [existing] = await em.query<ItemRow[]>(
        'SELECT * FROM content_items WHERE source_run_id=$1 AND owner_id=$2',
        [runId, ownerId],
      );
      if (existing) return this.detail(em, existing);
      if (run.status !== 'succeeded' || !run.output)
        throw new ApiError(422, 'RUN_NOT_READY', '只有已完成且有候选稿的任务才能加入内容库。');
      const parsed = runOutputSchema.safeParse(run.output);
      if (!parsed.success) throw new ApiError(422, 'INVALID_OUTPUT', '原始稿件格式不可编辑。');
      const output = parsed.data;
      const id = randomUUID();
      const [row] = await em.query<ItemRow[]>(
        `
        INSERT INTO content_items(id,owner_id,source_run_id,account_name,platform,is_mock,title,status,current_version,revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,'draft',1,1) RETURNING *`,
        [
          id,
          ownerId,
          runId,
          run.snapshot.account.name,
          run.snapshot.account.platform,
          run.snapshot.provider === 'mock' || output.isMock,
          output.title,
        ],
      );
      await em.query(
        `INSERT INTO content_versions(content_id,version,title,document,kind)
        VALUES($1,1,$2,$3::jsonb,'generated')`,
        [id, output.title, JSON.stringify(output.document)],
      );
      return this.detail(em, row!);
    });
  }
  async list(ownerId: string, page: number, pageSize: number): Promise<Page<ContentItem>> {
    return this.db.transaction('REPEATABLE READ', async (em) => {
      const counts = await em.query<{ total: number }[]>(
        'SELECT count(*)::int AS total FROM content_items WHERE owner_id=$1',
        [ownerId],
      );
      const rows = await em.query<ItemRow[]>(
        `SELECT * FROM content_items WHERE owner_id=$1
        ORDER BY updated_at DESC, id LIMIT $2 OFFSET $3`,
        [ownerId, pageSize, (page - 1) * pageSize],
      );
      return { items: rows.map(toItem), total: counts[0]!.total, page, pageSize };
    });
  }
  async get(ownerId: string, id: string): Promise<ContentDetail> {
    return this.db.transaction('REPEATABLE READ', async (em) =>
      this.detail(em, await this.owned(em, ownerId, id)),
    );
  }
  async getVersion(ownerId: string, id: string, version: number) {
    return this.db.transaction(async (em) => {
      await this.owned(em, ownerId, id);
      return this.version(em, id, version);
    });
  }
  async versions(ownerId: string, id: string, page: number, pageSize: number) {
    return this.db.transaction('REPEATABLE READ', async (em) => {
      const row = await this.owned(em, ownerId, id);
      const versions = await em.query<Omit<VersionRow, 'document'>[]>(
        `
        SELECT version,title,kind,restored_from,note,created_at FROM content_versions
        WHERE content_id=$1 ORDER BY version DESC LIMIT $2 OFFSET $3`,
        [id, pageSize, (page - 1) * pageSize],
      );
      return {
        items: versions.map((v) => ({
          version: v.version,
          title: v.title,
          kind: v.kind,
          restoredFrom: v.restored_from,
          note: v.note,
          createdAt: v.created_at.toISOString(),
        })),
        total: row.current_version,
        page,
        pageSize,
      };
    });
  }
  async reviews(
    ownerId: string,
    id: string,
    page: number,
    pageSize: number,
  ): Promise<Page<ContentReview>> {
    return this.db.transaction('REPEATABLE READ', async (em) => {
      await this.owned(em, ownerId, id);
      const counts = await em.query<{ total: number }[]>(
        'SELECT count(*)::int AS total FROM content_reviews WHERE content_id=$1',
        [id],
      );
      const rows = await em.query<
        {
          id: string;
          version: number;
          action: ContentReview['action'];
          note: string;
          created_at: Date;
        }[]
      >(
        `
        SELECT id,version,action,note,created_at FROM content_reviews WHERE content_id=$1
        ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,
        [id, pageSize, (page - 1) * pageSize],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          version: r.version,
          action: r.action,
          note: r.note,
          createdAt: r.created_at.toISOString(),
        })),
        total: counts[0]!.total,
        page,
        pageSize,
      };
    });
  }

  async mutate(
    ownerId: string,
    id: string,
    kind: 'save' | 'restore' | 'review',
    input: SaveContentInput | RestoreContentInput | ReviewContentInput,
    key?: string,
  ): Promise<ContentDetail> {
    if (!key || !/^[a-zA-Z0-9_-]{16,128}$/.test(key))
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请提供 16-128 位的 Idempotency-Key。');
    const hash = hashToken(JSON.stringify([kind, input]));
    return this.db.transaction(async (em) => {
      const row = await this.owned(em, ownerId, id, true);
      const [receipt] = await em.query<{ input_hash: string; result: ContentItem }[]>(
        'SELECT input_hash,result FROM content_operations WHERE content_id=$1 AND key=$2',
        [id, key],
      );
      if (receipt) {
        if (receipt.input_hash !== hash)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '相同请求标识不能用于不同内容。');
        // Replay the exact saved result, even if newer edits or reviews have since happened.
        return {
          item: receipt.result,
          version: await this.version(em, id, receipt.result.currentVersion),
        };
      }
      if (row.revision !== input.baseRevision)
        throw new ApiError(
          409,
          'CONTENT_CONFLICT',
          '内容已在其他页面更新。请保留本地修改并读取最新版本。',
        );
      if (kind === 'save' || kind === 'restore') {
        const restored =
          kind === 'restore'
            ? await this.version(em, id, (input as RestoreContentInput).version)
            : null;
        const saved = input as SaveContentInput;
        const title = restored?.title ?? saved.title;
        const document = restored?.document ?? saved.document;
        await em.query(
          `INSERT INTO content_versions(content_id,version,title,document,kind,restored_from,note)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)`,
          [
            id,
            row.current_version + 1,
            title,
            JSON.stringify(document),
            kind === 'restore' ? 'restore' : 'edit',
            restored?.version ?? null,
            restored ? `Restored from v${restored.version}` : saved.note,
          ],
        );
        await em.query(
          `UPDATE content_items SET title=$2,current_version=current_version+1,status='draft',
          revision=revision+1,updated_at=now() WHERE id=$1`,
          [id, title],
        );
      } else {
        const review = input as ReviewContentInput;
        const allowed =
          review.action === 'submit'
            ? ['draft', 'changes_requested'].includes(row.status)
            : row.status === 'pending_review';
        if (!allowed)
          throw new ApiError(422, 'INVALID_REVIEW_TRANSITION', '当前状态不能执行此审核操作。');
        if (review.action === 'approve' && row.is_mock)
          throw new ApiError(
            422,
            'MOCK_NOT_APPROVABLE',
            '模拟内容不能标记为审核通过；请使用真实模型稿件。',
          );
        const status = {
          submit: 'pending_review',
          approve: 'approved',
          request_changes: 'changes_requested',
        }[review.action];
        await em.query(
          `INSERT INTO content_reviews(id,content_id,version,action,note,actor_id)
          VALUES($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), id, row.current_version, review.action, review.note, ownerId],
        );
        await em.query(
          'UPDATE content_items SET status=$2,revision=revision+1,updated_at=now() WHERE id=$1',
          [id, status],
        );
      }
      const result = await this.detail(em, await this.owned(em, ownerId, id));
      await em.query(
        'INSERT INTO content_operations(content_id,key,input_hash,result) VALUES($1,$2,$3,$4::jsonb)',
        [id, key, hash, JSON.stringify(result.item)],
      );
      return result;
    });
  }
  async export(ownerId: string, id: string, input: ExportContentInput) {
    return this.db.transaction('REPEATABLE READ', async (em) => {
      const row = await this.owned(em, ownerId, id);
      const version = await this.version(em, id, input.version);
      const approved =
        !row.is_mock && row.status === 'approved' && row.current_version === version.version;
      if (!approved && !input.acknowledgeUnreviewed)
        throw new ApiError(
          422,
          'EXPORT_ACK_REQUIRED',
          '此版本为模拟、历史或未审核稿，请先确认风险再导出。',
        );
      return renderContentExport(toItem(row), version, input.format, approved);
    });
  }
}
