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
  Req,
} from '@nestjs/common';
import { modelCheckInputSchema, reconciliationSchema } from '@creator-ai/contracts';
import { SchemaPipe, type AuthRequest } from '../../common/http';
import { ModelCheckService } from './model-check.service';

@Controller('models/:id/checks')
export class ModelCheckController {
  constructor(@Inject(ModelCheckService) private readonly checks: ModelCheckService) {}
  @Get()
  list(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.checks.list(req.user.id, id);
  }
  @Post()
  @HttpCode(200)
  create(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(modelCheckInputSchema)) _input: { confirm: true },
    @Headers('idempotency-key') key?: string,
  ) {
    return this.checks.create(req.user.id, id, key);
  }
  @Post(':checkId/reconcile')
  @HttpCode(200)
  resolve(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body(new SchemaPipe(reconciliationSchema)) input: { note: string },
  ) {
    return this.checks.resolve(req.user.id, id, checkId, input.note);
  }
}
