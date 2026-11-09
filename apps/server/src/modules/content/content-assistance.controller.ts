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
} from '@nestjs/common';
import { contentTurnInputSchema, type ContentTurnInput } from '@creator-ai/contracts';
import { pagination, SchemaPipe, type AuthRequest } from '../../common/http';
import { ContentAssistanceService } from './content-assistance.service';

@Controller('contents/:id/assistant-turns')
export class ContentAssistanceController {
  constructor(
    @Inject(ContentAssistanceService) private readonly assistance: ContentAssistanceService,
  ) {}
  @Post()
  @HttpCode(202)
  create(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(contentTurnInputSchema)) input: ContentTurnInput,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.assistance.create(req.user.id, id, input, key);
  }
  @Get()
  list(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('pageSize') size?: string,
  ) {
    const p = pagination(page, size);
    return this.assistance.list(req.user.id, id, p.page, p.pageSize);
  }
  @Get('writing-profile')
  writingProfile(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.assistance.writingProfiles(req.user.id, id);
  }
  @Get(':turnId')
  get(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('turnId', ParseUUIDPipe) turnId: string,
  ) {
    return this.assistance.get(req.user.id, id, turnId);
  }
}
