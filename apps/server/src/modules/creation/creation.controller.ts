import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import {
  continueRunSchema,
  createRunSchema,
  reconciliationSchema,
  teamResponseSchema,
  type TeamResponse,
  type ContinueRunInput,
  type CreateRunInput,
} from '@creator-ai/contracts';
import { defer, exhaustMap, finalize, takeWhile, timer } from 'rxjs';
import { ApiError, pagination, RawResponse, SchemaPipe, type AuthRequest } from '../../common/http';
import { AuthService } from '../auth/auth.service';
import { readSessionCookie } from '../auth/credentials';
import { CreationService } from './creation.service';

@Controller('creation-runs')
export class CreationController {
  private readonly streams = new Map<string, number>();
  constructor(
    @Inject(CreationService) private readonly creation: CreationService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Post()
  @HttpCode(202)
  create(
    @Req() req: AuthRequest,
    @Body(new SchemaPipe(createRunSchema)) input: CreateRunInput,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.creation.create(req.user.id, input, key);
  }
  @Get()
  list(@Req() req: AuthRequest, @Query('page') page?: string, @Query('pageSize') size?: string) {
    const p = pagination(page, size);
    return this.creation.list(req.user.id, p.page, p.pageSize);
  }
  @Get(':id')
  get(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.creation.get(req.user.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.creation.cancel(req.user.id, id);
  }

  @Post(':id/continue')
  @HttpCode(202)
  continueDraft(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(continueRunSchema)) input: ContinueRunInput,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.creation.continueDraft(req.user.id, id, input, key);
  }

  @Get(':id/history')
  history(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('pageSize') size?: string,
  ) {
    const p = pagination(page, size);
    return this.creation.history(req.user.id, id, p.page, p.pageSize);
  }

  @Post(':id/reconcile')
  @HttpCode(200)
  reconcile(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(reconciliationSchema)) input: { note: string },
  ) {
    return this.creation.reconcile(req.user.id, id, input.note);
  }

  @Post(':id/actions/:actionId/respond')
  @HttpCode(200)
  respond(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('actionId', ParseUUIDPipe) actionId: string,
    @Body(new SchemaPipe(teamResponseSchema)) input: TeamResponse,
  ) {
    return this.creation.respond(req.user.id, id, actionId, input);
  }

  @RawResponse()
  @Sse(':id/events')
  async events(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.creation.get(req.user.id, id);
    const ownerId = req.user.id;
    if ((this.streams.get(ownerId) ?? 0) >= 6)
      throw new ApiError(429, 'SSE_LIMIT', '打开的任务连接过多，请关闭其他页面。');
    const token = readSessionCookie(req.headers.cookie);
    let lastRevision = 0;
    // Each connection starts with a database snapshot; SSE is not an event-history API.
    return defer(() => {
      this.streams.set(ownerId, (this.streams.get(ownerId) ?? 0) + 1);
      return timer(0, 2000).pipe(
        exhaustMap(async (): Promise<MessageEvent> => {
          try {
            await this.auth.authenticate(token);
            const run = await this.creation.get(ownerId, id);
            if (run.revision !== lastRevision) {
              lastRevision = run.revision;
              return { type: 'run.snapshot', id: String(run.revision), data: run };
            }
            return { type: 'heartbeat', data: { at: new Date().toISOString() } };
          } catch (error) {
            return {
              type:
                error instanceof ApiError && error.getStatus() === 401
                  ? 'session.expired'
                  : 'stream.unavailable',
              data: {},
            };
          }
        }),
        takeWhile(
          (event) => !['session.expired', 'stream.unavailable'].includes(event.type ?? ''),
          true,
        ),
        finalize(() => {
          const count = (this.streams.get(ownerId) ?? 1) - 1;
          if (count > 0) this.streams.set(ownerId, count);
          else this.streams.delete(ownerId);
        }),
      );
    });
  }
}
