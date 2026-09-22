import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ReconcileSettings,
  RECONCILE_ENV_KEYS,
  resolveReconcileSettings,
} from './reconcile-settings';

/**
 * 17B.4B — résolveur de configuration du moteur de réconciliation.
 *
 * LIT L'ENVIRONNEMENT ICI (via ConfigService, JAMAIS process.env côté moteur)
 * et expose des settings VALIDÉS au reste du code. Politique retenue et testée :
 * chaque variable invalide (absente, non entière, hors bornes) bascule sur le
 * défaut avec un Logger.warn SANS secret — jamais de crash au boot ni au run.
 *
 * Priorité actuelle : env → défauts. La base PostgreSQL → env → défauts sera
 * ajoutée en 17B.4C UNIQUEMENT ici (le ReconcileService ne change pas : il
 * appelle `getSettings()` et relit à chaque cycle, donc une modification
 * runtime est visible sans redémarrage).
 *
 * `getSettings()` reconstruit l'objet à chaque appel : déterministe (une valeur
 * inconnue = défaut) et testable sans mock d'horloge/timer.
 */
@Injectable()
export class ReconcileSettingsService {
  private readonly log = new Logger(ReconcileSettingsService.name);

  constructor(private readonly config: ConfigService) {}

  getSettings(): ReconcileSettings {
    const env: Record<string, string | undefined> = {};
    for (const key of Object.values(RECONCILE_ENV_KEYS)) {
      env[key] = this.config.get<string>(key);
    }
    return resolveReconcileSettings(env, (message) => this.log.warn(message));
  }
}