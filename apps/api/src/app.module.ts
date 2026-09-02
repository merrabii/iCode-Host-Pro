import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { ServersModule } from './servers/servers.module';
import { ManagerModule } from './manager/manager.module';
import { AuditModule } from './audit/audit.module';
import { InvitationsModule } from './invitations/invitations.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { MailModule } from './mail/mail.module';
import { SupportModule } from './support/support.module';
import { TicketsModule } from './tickets/tickets.module';
import { loadAppConfig } from './config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [loadAppConfig],
    }),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    ServersModule,
    ManagerModule,
    AuditModule,
    InvitationsModule,
    SubscriptionsModule,
    MailModule,
    SupportModule,
    TicketsModule,
  ],
})
export class AppModule {}