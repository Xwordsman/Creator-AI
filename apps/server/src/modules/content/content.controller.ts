import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  exportContentSchema,
  promoteContentSchema,
  restoreContentSchema,
  reviewContentSchema,
  saveContentSchema,
  type ExportContentInput,
  type RestoreContentInput,
  type ReviewContentInput,
  type SaveContentInput,
} from '@creator-ai/contracts';
import { ApiError, pagination, RawResponse, SchemaPipe, type AuthRequest } from '../../common/http';
import { ContentService } from './content.service';

@Controller('contents')
export class ContentController {
  constructor(@Inject(ContentService) private readonly contents: ContentService) {}
  @Post()
  promote(
    @Req() req: AuthRequest,
    @Body(new SchemaPipe(promoteContentSchema)) input: { sourceRunId: string },
  ) {
    return this.contents.promote(req.user.id, input.sourceRunId);
  }
  @Get()
  list(@Req() req: AuthRequest, @Query('page') page?: string, @Query('pageSize') size?: string) {
    const p = pagination(page, size);
    return this.contents.list(req.user.id, p.page, p.pageSize);
  }
  @Get(':id')
  get(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.contents.get(req.user.id, id);
  }
  @Get(':id/versions')
  versions(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('pageSize') size?: string,
  ) {
    const p = pagination(page, size);
    return this.contents.versions(req.user.id, id, p.page, p.pageSize);
  }
  @Get(':id/versions/:version')
  version(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    if (version < 1) throw new ApiError(400, 'INVALID_VERSION', '版本号无效。');
    return this.contents.getVersion(req.user.id, id, version);
  }
  @Get(':id/reviews')
  reviews(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('pageSize') size?: string,
  ) {
    const p = pagination(page, size);
    return this.contents.reviews(req.user.id, id, p.page, p.pageSize);
  }
  @Post(':id/versions')
  @HttpCode(200)
  save(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(saveContentSchema)) input: SaveContentInput,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.contents.mutate(req.user.id, id, 'save', input, key);
  }
  @Post(':id/restore')
  @HttpCode(200)
  restore(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(restoreContentSchema)) input: RestoreContentInput,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.contents.mutate(req.user.id, id, 'restore', input, key);
  }
  @Post(':id/reviews')
  @HttpCode(200)
  review(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(reviewContentSchema)) input: ReviewContentInput,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.contents.mutate(req.user.id, id, 'review', input, key);
  }
  @Post(':id/export')
  @HttpCode(200)
  @RawResponse()
  async export(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(exportContentSchema)) input: ExportContentInput,
    @Res() res: Response,
  ) {
    const file = await this.contents.export(req.user.id, id, input);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(file.mime).attachment(file.filename).send(file.body);
  }
}
