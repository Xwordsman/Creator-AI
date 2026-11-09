import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { modelConnectionInputSchema, type ModelConnectionInput } from '@creator-ai/contracts';
import { SchemaPipe, type AuthRequest } from '../../common/http';
import { ModelService } from './model.service';

@Controller('models')
export class ModelController {
  constructor(@Inject(ModelService) private readonly models: ModelService) {}
  @Get('capabilities') capabilities() {
    return this.models.capabilities();
  }
  @Get() list(@Req() req: AuthRequest) {
    return this.models.list(req.user.id);
  }
  @Post() create(
    @Req() req: AuthRequest,
    @Body(new SchemaPipe(modelConnectionInputSchema)) input: ModelConnectionInput,
  ) {
    return this.models.create(req.user.id, input);
  }
  @Post(':id/availability')
  @HttpCode(200)
  availability(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new SchemaPipe(z.strictObject({ enabled: z.boolean() }))) input: { enabled: boolean },
  ) {
    return this.models.setEnabled(req.user.id, id, input.enabled);
  }
}
