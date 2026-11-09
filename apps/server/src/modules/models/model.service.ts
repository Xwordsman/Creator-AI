import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';
import type {
  ModelConnection,
  ModelConnectionInput,
  ModelSnapshot,
  RuntimeCapabilities,
} from '@creator-ai/contracts';
import { ApiError } from '../../common/http';
import {
  decryptModelKey,
  encryptModelKey,
  modelSettings,
  validateModelUrl,
} from './model-security';

interface ConnectionRow {
  id: string;
  owner_id: string;
  config: Omit<ModelSnapshot, 'id'>;
  encrypted_key: string;
  enabled: boolean;
  created_at: Date;
}
const toConnection = (row: ConnectionRow): ModelConnection => ({
  ...row.config,
  id: row.id,
  enabled: row.enabled,
  hasKey: true,
  createdAt: row.created_at.toISOString(),
});

@Injectable()
export class ModelService {
  constructor(@Inject(DataSource) private readonly db: DataSource) {}
  capabilities(): RuntimeCapabilities {
    const { modelMode, canConfigureModels, allowedHosts } = modelSettings();
    return {
      modelMode,
      canConfigureModels,
      allowedHosts,
      tools: ['load_skill', 'read_skill_file'],
    };
  }
  async list(ownerId: string): Promise<ModelConnection[]> {
    const rows: ConnectionRow[] = await this.db.query(
      'SELECT id, config, enabled, created_at FROM model_connections WHERE owner_id=$1 ORDER BY created_at',
      [ownerId],
    );
    return rows.map(toConnection);
  }
  async create(ownerId: string, input: ModelConnectionInput): Promise<ModelConnection> {
    const url = validateModelUrl(input.baseUrl);
    const id = randomUUID();
    const { apiKey, ...config } = input;
    config.baseUrl = url.href.replace(/\/$/, '');
    return this.db.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${ownerId}:models`]);
      const counts: { count: string }[] = await em.query(
        'SELECT count(*) FROM model_connections WHERE owner_id=$1',
        [ownerId],
      );
      if (Number(counts[0]!.count) >= 20)
        throw new ApiError(422, 'MODEL_LIMIT', '最多保存 20 个模型连接。');
      const rows: ConnectionRow[] = await em.query(
        'INSERT INTO model_connections(id,owner_id,config,encrypted_key) VALUES($1,$2,$3::jsonb,$4) RETURNING id, config, enabled, created_at',
        [id, ownerId, JSON.stringify(config), encryptModelKey(apiKey, `${ownerId}:${id}`)],
      );
      return toConnection(rows[0]!);
    });
  }
  async setEnabled(ownerId: string, id: string, enabled: boolean): Promise<ModelConnection> {
    const rows: ConnectionRow[] = await this.db.query(
      'WITH changed AS (UPDATE model_connections SET enabled=$3 WHERE id=$1 AND owner_id=$2 RETURNING id, config, enabled, created_at) SELECT * FROM changed',
      [id, ownerId, enabled],
    );
    if (!rows.length) throw new ApiError(404, 'MODEL_NOT_FOUND', '模型连接不存在。');
    return toConnection(rows[0]!);
  }
  async snapshot(em: EntityManager, ownerId: string, id: string): Promise<ModelSnapshot> {
    const rows: ConnectionRow[] = await em.query(
      'SELECT id, config, enabled FROM model_connections WHERE id=$1 AND owner_id=$2',
      [id, ownerId],
    );
    const row = rows[0];
    if (!row) throw new ApiError(404, 'MODEL_NOT_FOUND', '模型连接不存在。');
    if (!row.enabled) throw new ApiError(422, 'MODEL_DISABLED', '模型连接已停用。');
    validateModelUrl(row.config.baseUrl);
    return { ...row.config, id: row.id };
  }
  async credentials(ownerId: string, model: ModelSnapshot): Promise<string> {
    validateModelUrl(model.baseUrl);
    const rows: ConnectionRow[] = await this.db.query(
      'SELECT encrypted_key FROM model_connections WHERE id=$1 AND owner_id=$2 AND enabled=true',
      [model.id, ownerId],
    );
    if (!rows[0]) throw new ApiError(422, 'MODEL_DISABLED', '模型已停用，停止后续调用。');
    return decryptModelKey(rows[0].encrypted_key, `${ownerId}:${model.id}`);
  }
}
