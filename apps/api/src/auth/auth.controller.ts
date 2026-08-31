import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';

const DEFAULT_COOKIE = 'ihp_refresh';

type CookieRequest = Request & { cookies?: Record<string, string> };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly cookieName: string;

  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {
    this.cookieName = this.config.get<string>('cookieName') ?? DEFAULT_COOKIE;
  }

  @Post('register')
  @ApiOperation({ summary: 'Closed — returns 410 Gone (invitation required)' })
  register(): Promise<never> {
    // Phase 5 (ADR-020): replace throws 410; kept as a route so clients get a
    // meaningful Gone instead of 404.
    return this.auth.register(null as unknown as RegisterDto);
  }

  @Post('accept-invite')
  @ApiOperation({ summary: 'Accept a one-time invitation and obtain tokens' })
  async acceptInvite(
    @Body() dto: AcceptInviteDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.acceptInvite(dto);
    this.setCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Post('login')
  @ApiOperation({ summary: 'Log in and obtain tokens' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.auth.login(dto);
    this.setCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Rotate refresh token, return new access token' })
  async refresh(@Req() req: CookieRequest, @Res({ passthrough: true }) res: Response) {
    const token = this.readCookie(req);
    if (!token) {
      throw new UnauthorizedException('Missing refresh token');
    }
    const tokens = await this.auth.refresh(token);
    this.setCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Post('logout')
  @ApiOperation({ summary: 'Revoke the refresh token and clear the cookie' })
  async logout(@Req() req: CookieRequest, @Res({ passthrough: true }) res: Response) {
    const token = this.readCookie(req);
    if (token) {
      await this.auth.logout(token);
    }
    res.clearCookie(this.cookieName, { httpOnly: true, path: '/' });
    return { success: true };
  }

  private readCookie(req: CookieRequest): string | undefined {
    return req.cookies?.[this.cookieName];
  }

  private cookieOptions() {
    const days = this.config.get<number>('refreshExpiresInDays') ?? 30;
    const isProduction =
      (this.config.get<string>('nodeEnv') ?? 'development') === 'production';
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: isProduction,
      path: '/',
      maxAge: days * 24 * 60 * 60 * 1000,
    };
  }

  private setCookie(res: Response, refreshToken: string): void {
    res.cookie(this.cookieName, refreshToken, this.cookieOptions());
  }
}