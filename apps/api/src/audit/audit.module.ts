import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

// The audit journal is cross-cutting: it is emitted by products/servers/users/
// auth services, so AuditModule is @Global and exports AuditService, making it
// injectable everywhere without each module importing it.
// NOTE: this module intentionally re-registers JwtModule + RolesGuard locally
// instead of importing AuthModule, to avoid a circular module dependency:
// AuthService (in AuthModule) injects the global AuditService while this
// controller needs the auth guards. JwtAuthGuard is auto-instantiated (its
// JwtService dep resolves from the JwtModule imported here).
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        secret: config.getOrThrow<string>('jwtSecret'),
        signOptions: {
          expiresIn: (config.get<string>('jwtExpiresIn') ?? '15m') as NonNullable<
            JwtModuleOptions['signOptions']
          >['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [AuditController],
  providers: [AuditService, RolesGuard],
  exports: [AuditService],
})
export class AuditModule {}