import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { JwtPayload } from '../types';

/**
 * OPTIONAL bearer — tunnel de commande unique pour l'espace client (Bloc 2).
 * Le checkout sert les DEUX cas sans route séparée :
 *  - visiteur invité → aucun token ni token invalide ⇒ `req.user = null` ;
 *  - client connecté qui UPGRADE (repoint pack, data préservée) → token validé
 *    ⇒ `req.user = payload`.
 * Ce garde ne lève JAMAIS ; le service tranche selon la présence de `user`.
 * (§ sécurité : un token invalide est traité comme invité, les montants restent
 * recalculés serveur, l'upgrade exige toujours une commande PAID.)
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user: JwtPayload | null }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      req.user = null;
      return true;
    }
    try {
      req.user = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
    } catch {
      req.user = null;
    }
    return true;
  }
}
