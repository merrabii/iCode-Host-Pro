import { IsEmail, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// Phase 3 — paramètres du compte Cloudflare. Le jeton est write-only :
// '' = effacé, non vide = chiffré (AES-256-GCM) au repos, undefined = inchangé.
export class UpdateCloudflareSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(400)
  apiToken?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  accountEmail?: string;
}

export class SetRootDomainDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  domainId?: string | null;
}

const TYPE_RE = /^(A|AAAA|CNAME|MX|TXT|SRV|NS|CAA)$/;

export class RegisterDomainDto {
  @IsString()
  @MaxLength(200)
  zoneId!: string;

  @IsString()
  @Matches(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i, { message: 'Nom de domaine invalide.' })
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cnameTarget?: string;
}

export class UpdateDomainDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cnameTarget?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;
}

export class CreateDnsRecordDto {
  @IsString()
  @Matches(TYPE_RE, { message: 'Type DNS invalide (A, AAAA, CNAME, MX, TXT, SRV, NS, CAA).' })
  type!: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'NS' | 'CAA';

  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(200)
  content!: string;

  @IsOptional()
  proxied?: boolean;

  @IsOptional()
  ttl?: number;
}

export class CheckSubdomainDto {
  @IsString()
  @Matches(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i, { message: 'Sous-domaine invalide.' })
  @MaxLength(63)
  subdomain!: string;

  @IsString()
  @MaxLength(64)
  domainId!: string;
}