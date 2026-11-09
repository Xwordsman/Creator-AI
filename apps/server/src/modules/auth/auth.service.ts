import { Inject, Injectable } from '@nestjs/common';
import { DataSource, LessThan, MoreThan } from 'typeorm';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import type { SessionInfo } from '@creator-ai/contracts';
import { ApiError } from '../../common/http';
import { SessionEntity, UserEntity } from '../../database/entities';
import { hashToken, verifyPassword } from './credentials';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DataSource) private readonly db: DataSource,
    @Inject(Redis) private readonly redis: Redis,
  ) {}

  async login(
    username: string,
    secret: string,
    ip: string,
  ): Promise<{ token: string; info: SessionInfo }> {
    // Count both network and username buckets atomically; failed Redis checks fail closed.
    for (const key of [
      `login:ip:${hashToken(ip)}`,
      `login:user:${hashToken(username.toLowerCase())}`,
    ]) {
      const count = Number(
        await this.redis.eval(
          "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 300) end; return n",
          1,
          key,
        ),
      );
      if (count > 15) throw new ApiError(429, 'LOGIN_RATE_LIMIT', '尝试次数过多，请五分钟后重试。');
    }
    const user = await this.db
      .getRepository(UserEntity)
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.username = :username', { username })
      .getOne();
    const dummy = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const valid = await verifyPassword(secret, user?.passwordHash ?? dummy);
    if (!user || !valid) throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码不正确。');
    const token = randomBytes(32).toString('hex');
    const session = this.db.getRepository(SessionEntity).create({
      tokenHash: hashToken(token),
      userId: user.id,
      csrfToken: randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    await this.db.getRepository(SessionEntity).delete({ expiresAt: LessThan(new Date()) });
    await this.db.getRepository(SessionEntity).save(session);
    return { token, info: this.toInfo(user, session) };
  }

  async authenticate(token: string | null) {
    if (!token) throw new ApiError(401, 'AUTH_REQUIRED', '请先登录。');
    const session = await this.db
      .getRepository(SessionEntity)
      .findOneBy({ tokenHash: hashToken(token), expiresAt: MoreThan(new Date()) });
    const user =
      session && (await this.db.getRepository(UserEntity).findOneBy({ id: session.userId }));
    if (!session || !user) throw new ApiError(401, 'SESSION_EXPIRED', '登录已失效，请重新登录。');
    return { session, user };
  }

  async logout(session: SessionEntity): Promise<void> {
    await this.db.getRepository(SessionEntity).delete({ tokenHash: session.tokenHash });
  }

  toInfo(user: UserEntity, session: SessionEntity): SessionInfo {
    return {
      user: { id: user.id, username: user.username },
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    };
  }
}
