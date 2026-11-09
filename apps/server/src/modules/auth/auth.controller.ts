import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { loginSchema } from '@creator-ai/contracts';
import { Public, SchemaPipe, type AuthRequest } from '../../common/http';
import type { Environment } from '../../config/environment';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject('ENV') private readonly env: Environment,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new SchemaPipe(loginSchema)) input: { username: string; password: string },
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(input.username, input.password, req.ip ?? 'unknown');
    res.cookie('creator_session', result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.env.secureCookies,
      path: '/api',
      expires: new Date(result.info.expiresAt),
    });
    return result.info;
  }

  @Get('session')
  session(@Req() req: AuthRequest) {
    return this.auth.toInfo(req.user, req.session);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.session);
    res.clearCookie('creator_session', {
      path: '/api',
      httpOnly: true,
      sameSite: 'strict',
      secure: this.env.secureCookies,
    });
    return { loggedOut: true };
  }
}
