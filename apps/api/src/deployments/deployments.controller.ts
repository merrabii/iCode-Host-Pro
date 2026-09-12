import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/types';
import { DeploymentsService } from './deployments.service';
import { CreateDeploymentDto } from './dto/create-deployment.dto';
import { DetectRepoDto } from './dto/detect-repo.dto';
import { BuildConfigPreviewDto } from './dto/build-config.dto';

// Phase 10bis (M+N) — espace client : repos GitHub autodétectés + déploiement
// sur le serveur Coolify connecté. Même contrat que ClientController (Phase 5) :
// tout utilisateur authentifié, ownership imposée dans le service (404 pour
// autrui). L'impersonation est bloquée par JwtAuthGuard sur POST (lecture seule).
@ApiTags('client')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('client')
export class DeploymentsController {
  constructor(private readonly deployments: DeploymentsService) {}

  @Get('github/repos')
  @ApiOperation({ summary: 'List my auto-detected GitHub repos (Phase 10bis)' })
  listRepos(@CurrentUser() actor: JwtPayload) {
    return this.deployments.listRepos(actor);
  }

  @Post('github/link-status')
  @ApiOperation({ summary: 'GitHub link status — returns also when absent (Phase 10bis)' })
  linkStatus(@CurrentUser() actor: JwtPayload) {
    return this.deployments.linkStatus(actor);
  }

  @Post('deployments/detect')
  @ApiOperation({
    summary: 'Auto-detect a pasted git repo URL (branch, language, build pack) — no GitHub link needed (Phase 10bis.5)',
  })
  detect(@Body() dto: DetectRepoDto, @CurrentUser() actor: JwtPayload) {
    return this.deployments.detect(actor, dto.url);
  }

  @Post('deployments')
  @ApiOperation({ summary: 'Deploy a GitHub repo to my connected Coolify server (Phase 10bis)' })
  create(@Body() dto: CreateDeploymentDto, @CurrentUser() actor: JwtPayload) {
    return this.deployments.create(dto, actor);
  }

  @Post('deployments/preview')
  @ApiOperation({
    summary: 'Pre-fill build config from codediali.toml/netlify.toml/detection (Phase 16)',
  })
  preview(@Body() dto: BuildConfigPreviewDto, @CurrentUser() actor: JwtPayload) {
    return this.deployments.previewBuildConfig(dto.repoFullName, dto.branch, actor);
  }

  @Post('deployments/check-empty')
  @ApiOperation({ summary: 'Detect an empty repository before deploy (Phase 16)' })
  checkEmpty(@Body() dto: BuildConfigPreviewDto, @CurrentUser() actor: JwtPayload) {
    return this.deployments.checkRepoEmpty(dto.repoFullName, dto.branch, actor);
  }

  @Get('deployments')
  @ApiOperation({ summary: 'List my deployments (Phase 10bis)' })
  listMine(@CurrentUser() actor: JwtPayload) {
    return this.deployments.listMine(actor);
  }

  @Get('deployments/:id')
  @ApiOperation({ summary: 'Get one of my deployments — live status poll (Phase 10bis)' })
  findMine(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.deployments.findMine(id, actor);
  }

  @Delete('deployments/:id')
  @ApiOperation({ summary: 'Delete one of my deployments — frees the app quota (Phase 13)' })
  remove(@Param('id') id: string, @CurrentUser() actor: JwtPayload) {
    return this.deployments.remove(id, actor);
  }
}
