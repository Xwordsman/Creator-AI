import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { InfrastructureModule } from './infrastructure.module';
import { EnvelopeInterceptor } from './common/http';
import { AuthService } from './modules/auth/auth.service';
import { AuthController } from './modules/auth/auth.controller';
import { AuthGuard } from './modules/auth/auth.guard';
import { CatalogService } from './modules/catalog/catalog.service';
import { CatalogController } from './modules/catalog/catalog.controller';
import { CreationService } from './modules/creation/creation.service';
import { CreationController } from './modules/creation/creation.controller';
import { HealthController } from './health.controller';
import { ModelService } from './modules/models/model.service';
import { ModelController } from './modules/models/model.controller';
import { ModelCheckController } from './modules/models/model-check.controller';
import { ModelCheckService } from './modules/models/model-check.service';

import { ContentController } from './modules/content/content.controller';
import { ContentService } from './modules/content/content.service';
import { ContentAssistanceService } from './modules/content/content-assistance.service';
import { ContentAssistanceController } from './modules/content/content-assistance.controller';

@Module({
  imports: [InfrastructureModule],
  controllers: [
    AuthController,
    CatalogController,
    CreationController,
    ModelController,
    ModelCheckController,
    HealthController,
    ContentController,
    ContentAssistanceController,
  ],
  providers: [
    AuthService,
    CatalogService,
    CreationService,
    ModelService,
    ModelCheckService,
    ContentService,
    ContentAssistanceService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
  ],
})
export class AppModule {}
