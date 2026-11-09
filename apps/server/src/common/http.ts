import {
  Catch,
  HttpException,
  Injectable,
  Logger,
  SetMetadata,
  type ArgumentsHost,
  type CallHandler,
  type ExceptionFilter,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import { map } from 'rxjs';
import type { SessionEntity, UserEntity } from '../database/entities';

export interface AuthRequest extends Request {
  requestId: string;
  session: SessionEntity;
  user: UserEntity;
}
export const Public = () => SetMetadata('public', true);
export const RawResponse = () => SetMetadata('raw', true);

export class ApiError extends HttpException {
  constructor(status: number, code: string, message: string, retryable = false) {
    super({ code, message, retryable }, status);
  }
}

export class SchemaPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  ) {}
  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new ApiError(400, 'INVALID_INPUT', '请检查必填项、长度和字段格式。');
    return result.data as T;
  }
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  intercept(context: ExecutionContext, next: CallHandler) {
    if (this.reflector.get('raw', context.getHandler())) return next.handle();
    const request = context.switchToHttp().getRequest<AuthRequest>();
    return next.handle().pipe(map((data: unknown) => ({ data, requestId: request.requestId })));
  }
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<AuthRequest>();
    const parserStatus =
      typeof exception === 'object' && exception !== null && 'type' in exception
        ? exception.type === 'entity.parse.failed'
          ? 400
          : exception.type === 'entity.too.large'
            ? 413
            : null
        : null;
    const status =
      exception instanceof HttpException ? exception.getStatus() : (parserStatus ?? 500);
    const error =
      exception instanceof ApiError
        ? exception.getResponse()
        : {
            code: status === 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`,
            message:
              status === 500
                ? '服务暂时不可用，请稍后重试。'
                : '请求无法处理，请检查输入或登录状态。',
            retryable: status >= 500,
          };
    if (status >= 500)
      this.logger.error({ requestId: request.requestId, status, event: 'request.failed' });
    if (!response.headersSent)
      response.status(status).json({ error, requestId: request.requestId });
    else response.end();
  }
}

export function pagination(page?: string, pageSize?: string) {
  const p = Number(page ?? 1);
  const size = Number(pageSize ?? 30);
  if (
    !Number.isInteger(p) ||
    p < 1 ||
    p > 100000 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 100
  ) {
    throw new ApiError(400, 'INVALID_PAGINATION', '分页参数无效。');
  }
  return { page: p, pageSize: size, skip: (p - 1) * size };
}
