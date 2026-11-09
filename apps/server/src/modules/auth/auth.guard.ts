import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError, type AuthRequest } from '../../common/http';
import type { Environment } from '../../config/environment';
import { AuthService } from './auth.service';
import { readSessionCookie } from './credentials';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject('ENV') private readonly env: Environment,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutating && request.headers.origin !== this.env.origin) {
      throw new ApiError(403, 'ORIGIN_REJECTED', '请求来源不可信，请从工作台页面操作。');
    }
    if (this.reflector.getAllAndOverride('public', [context.getHandler(), context.getClass()]))
      return true;
    const { session, user } = await this.auth.authenticate(
      readSessionCookie(request.headers.cookie),
    );
    if (mutating && request.headers['x-csrf-token'] !== session.csrfToken) {
      throw new ApiError(403, 'CSRF_REJECTED', '安全校验失效，请刷新后重试。');
    }
    request.session = session;
    request.user = user;
    return true;
  }
}
