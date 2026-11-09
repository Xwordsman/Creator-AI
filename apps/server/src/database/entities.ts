import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type {
  AccountInput,
  ExpertInput,
  RunOutput,
  RunSnapshot,
  RunStatus,
  Skill,
  PackageFile,
} from '@creator-ai/contracts';

@Entity('users')
export class UserEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column('varchar', { unique: true, length: 80 }) username!: string;
  @Column('text', { name: 'password_hash', select: false }) passwordHash!: string;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}

@Entity('sessions')
export class SessionEntity {
  @PrimaryColumn('text', { name: 'token_hash' }) tokenHash!: string;
  @Column('uuid', { name: 'user_id' }) userId!: string;
  @Column('text', { name: 'csrf_token' }) csrfToken!: string;
  @Column('timestamptz', { name: 'expires_at' }) expiresAt!: Date;
}

@Entity('accounts')
export class AccountEntity {
  @PrimaryColumn('uuid') id!: string;
  @Index() @Column('uuid', { name: 'owner_id' }) ownerId!: string;
  @Column('jsonb') profile!: AccountInput;
  @Column('integer', { default: 1 }) revision!: number;
  @Column('uuid', { name: 'default_expert_id', nullable: true }) defaultExpertId!: string | null;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}

@Entity('experts')
export class ExpertEntity {
  @PrimaryColumn('uuid') id!: string;
  @Index() @Column('uuid', { name: 'owner_id' }) ownerId!: string;
  @Column('integer') version!: number;
  @Column('jsonb') definition!: ExpertInput;
  @Column('boolean', { default: true }) enabled!: boolean;
  @Column('jsonb', { name: 'package_files', nullable: true }) packageFiles!: PackageFile[] | null;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}

@Entity('expert_versions')
export class ExpertVersionEntity {
  @PrimaryColumn('uuid', { name: 'expert_id' }) expertId!: string;
  @PrimaryColumn('integer') version!: number;
  @Column('jsonb') definition!: ExpertInput;
  @Column('integer', { name: 'restored_from', nullable: true }) restoredFrom!: number | null;
  @Column('jsonb', { name: 'package_files', nullable: true }) packageFiles!: PackageFile[] | null;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}

@Entity('skills')
@Index(['ownerId', 'key'], { unique: true })
export class SkillEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column('uuid', { name: 'owner_id' }) ownerId!: string;
  @Column('varchar', { length: 161 }) key!: string;
  @Column('integer') version!: number;
  @Column('boolean', { default: true }) enabled!: boolean;
  @Column('jsonb') definition!: Skill;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}

@Entity('skill_versions')
export class SkillVersionEntity {
  @PrimaryColumn('uuid', { name: 'skill_id' }) skillId!: string;
  @PrimaryColumn('integer') version!: number;
  @Column('jsonb') definition!: Skill;
  @Column('integer', { name: 'restored_from', nullable: true }) restoredFrom!: number | null;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
}

@Entity('creation_runs')
@Index(['ownerId', 'idempotencyKey'], { unique: true })
export class RunEntity {
  @PrimaryColumn('uuid') id!: string;
  @Column('uuid', { name: 'owner_id' }) ownerId!: string;
  @Column('varchar', { name: 'idempotency_key', length: 128 }) idempotencyKey!: string;
  @Column('text', { name: 'input_hash' }) inputHash!: string;
  @Column('varchar', { length: 24 }) status!: RunStatus;
  @Column('integer') revision!: number;
  @Column('integer') attempts!: number;
  @Column('jsonb') snapshot!: RunSnapshot;
  @Column('jsonb', { nullable: true }) output!: RunOutput | null;
  @Column('text', { name: 'failure_code', nullable: true }) failureCode!: string | null;
  @Column('uuid', { name: 'lease_token', nullable: true }) leaseToken!: string | null;
  @Column('timestamptz', { name: 'lease_expires_at', nullable: true }) leaseExpiresAt!: Date | null;
  @Column('timestamptz', { name: 'created_at' }) createdAt!: Date;
  @Column('timestamptz', { name: 'updated_at' }) updatedAt!: Date;
  @Column('boolean', { name: 'cancel_requested', default: false }) cancelRequested!: boolean;
  @Column('timestamptz', { name: 'started_at', nullable: true }) startedAt!: Date | null;
  @Column('integer', { name: 'charged_tokens', default: 0 }) chargedTokens!: number;
  @Column('integer', { name: 'reserved_tokens', default: 0 }) reservedTokens!: number;
  @Column('integer', { name: 'invocation_count', default: 0 }) invocationCount!: number;
  @Column('uuid', { name: 'parent_run_id', nullable: true }) parentRunId!: string | null;
  @Column('uuid', { name: 'root_run_id', nullable: true }) rootRunId!: string | null;
  @Column('integer', { name: 'continuation_depth', default: 0 }) continuationDepth!: number;
  @Column('integer', { name: 'active_ms', default: 0 }) activeMs!: number;
  @Column('timestamptz', { name: 'active_started_at', nullable: true })
  activeStartedAt!: Date | null;
  @Column('integer', { name: 'recovery_attempts', default: 0 }) recoveryAttempts!: number;
}

@Entity('task_outbox')
export class OutboxEntity {
  @PrimaryColumn('uuid', { name: 'run_id' }) runId!: string;
  @Column('integer') sequence!: number;
  @Column('timestamptz', { name: 'last_dispatched_at', nullable: true })
  lastDispatchedAt!: Date | null;
}

export const entities = [
  UserEntity,
  SessionEntity,
  AccountEntity,
  ExpertEntity,
  ExpertVersionEntity,
  SkillEntity,
  SkillVersionEntity,
  RunEntity,
  OutboxEntity,
];
