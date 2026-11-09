import {
  Body,
  Controller,
  Get,
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
import {
  accountInputSchema,
  expertInputSchema,
  type AccountInput,
  type ExpertInput,
  skillInputSchema,
  enabledSchema,
  type SkillInput,
  accountDefaultExpertSchema,
  type AccountDefaultExpertInput,
  restoreCapabilitySchema,
  type RestoreCapabilityInput,
  saveWritingCardsSchema,
  type SaveWritingCardsInput,
} from '@creator-ai/contracts';
import type { Response } from 'express';
import { pagination, RawResponse, SchemaPipe, type AuthRequest } from '../../common/http';
import { CatalogService } from './catalog.service';

@Controller()
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}
  @Get('accounts')
  listAccounts(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') size?: string,
  ) {
    const p = pagination(page, size);
    return this.catalog.listAccounts(req.user.id, p.page, p.pageSize);
  }
  @Post('accounts')
  createAccount(
    @Req() req: AuthRequest,
    @Body(new SchemaPipe(accountInputSchema)) input: AccountInput,
  ) {
    return this.catalog.createAccount(req.user.id, input);
  }
  @Get('accounts/:id')
  account(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.getAccount(req.user.id, id);
  }
  @Post('accounts/:id/writing-cards')
  @HttpCode(200)
  saveWritingCards(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(saveWritingCardsSchema)) input: SaveWritingCardsInput,
  ) {
    return this.catalog.saveWritingCards(req.user.id, id, input);
  }
  @Get('experts')
  listExperts(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') size?: string,
  ) {
    const p = pagination(page, size);
    return this.catalog.listExperts(req.user.id, p.page, p.pageSize);
  }
  @Post('accounts/:id/default-expert')
  setAccountDefault(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(accountDefaultExpertSchema)) input: AccountDefaultExpertInput,
  ) {
    return this.catalog.setAccountDefault(req.user.id, id, input);
  }
  @Post('experts/:id/restore')
  restoreExpert(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(restoreCapabilitySchema)) input: RestoreCapabilityInput,
  ) {
    return this.catalog.restoreExpert(req.user.id, id, input);
  }
  @Post('skills/:key/restore')
  restoreSkill(
    @Req() req: AuthRequest,
    @Param('key') key: string,
    @Body(new SchemaPipe(restoreCapabilitySchema)) input: RestoreCapabilityInput,
  ) {
    return this.catalog.restoreSkill(req.user.id, key, input);
  }
  @Post('experts')
  createExpert(
    @Req() req: AuthRequest,
    @Body(new SchemaPipe(expertInputSchema)) input: ExpertInput,
  ) {
    return this.catalog.createExpert(req.user.id, input);
  }
  @Post('experts/:id/versions')
  updateExpert(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('baseVersion', ParseIntPipe) base: number,
    @Body(new SchemaPipe(expertInputSchema)) input: ExpertInput,
  ) {
    return this.catalog.updateExpert(req.user.id, id, base, input);
  }
  @Get('skills')
  listSkills(
    @Req() req: AuthRequest,
    @Query('page') page?: string,
    @Query('pageSize') size?: string,
  ) {
    const p = pagination(page, size);
    return this.catalog.listSkills(req.user.id, p.page, p.pageSize);
  }
  @Post('skills')
  createSkill(@Req() req: AuthRequest, @Body(new SchemaPipe(skillInputSchema)) input: SkillInput) {
    return this.catalog.createSkill(req.user.id, input);
  }
  @Post('skills/:key/versions')
  updateSkill(
    @Req() req: AuthRequest,
    @Param('key') key: string,
    @Query('baseVersion', ParseIntPipe) base: number,
    @Body(new SchemaPipe(skillInputSchema)) input: SkillInput,
  ) {
    return this.catalog.updateSkill(req.user.id, key, base, input);
  }
  @Get('skills/:key/versions')
  skillVersions(
    @Req() req: AuthRequest,
    @Param('key') key: string,
    @Query('page') page?: string,
    @Query('pageSize') size?: string,
  ) {
    const p = pagination(page, size);
    return this.catalog.skillVersions(req.user.id, key, p.page, p.pageSize);
  }
  @Get('experts/:id/versions')
  expertVersions(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('pageSize') size?: string,
  ) {
    const p = pagination(page, size);
    return this.catalog.expertVersions(req.user.id, id, p.page, p.pageSize);
  }
  @Post('skills/:key/availability')
  skillAvailability(
    @Req() req: AuthRequest,
    @Param('key') key: string,
    @Body(new SchemaPipe(enabledSchema)) input: { enabled: boolean; baseVersion: number },
  ) {
    return this.catalog.setSkillEnabled(req.user.id, key, input.enabled, input.baseVersion);
  }
  @Post('experts/:id/availability')
  expertAvailability(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(enabledSchema)) input: { enabled: boolean; baseVersion: number },
  ) {
    return this.catalog.setExpertEnabled(req.user.id, id, input.enabled, input.baseVersion);
  }
  @Post('packages/preview')
  previewPackage(@Body() buffer: Buffer) {
    return this.catalog.previewPackage(buffer);
  }
  @Post('packages/import')
  importPackage(@Req() req: AuthRequest, @Body() buffer: Buffer) {
    return this.catalog.importPackage(req.user.id, buffer);
  }
  @Get('skills/:key/export')
  @RawResponse()
  async exportSkill(@Req() req: AuthRequest, @Param('key') key: string, @Res() response: Response) {
    const buffer = await this.catalog.exportSkill(req.user.id, key);
    response.type('application/zip').attachment('skill.zip').send(buffer);
  }
  @Get('experts/:id/export')
  @RawResponse()
  async exportExpert(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('original') original: string | undefined,
    @Res() response: Response,
  ) {
    const buffer = await this.catalog.exportExpert(req.user.id, id, original === 'true');
    response.type('application/zip').attachment('expert.zip').send(buffer);
  }
}
