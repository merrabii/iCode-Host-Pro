import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ReconcileService } from './reconcile.service';
import {
  RECONCILE_DEFAULT_SETTINGS,
  ReconcileSettings,
} from './reconcile-settings';
import { ReconcileSettingsService } from './reconcile-settings.service';

/** Rôle 17B.4C2 — pilote (runner) de l'observation récurrente.
 *
 *  Le moteur 17B.4B expose UNIQUEMENT ReconcileService.scanOnce(now) — aucune boucle
 *  propre, aucune dépendance infra directement. C'est ici (couche pilote) que vit le
 *  timer d'intervalle, et nulle part ailleurs :
 *   - la planification est pilotée par les settings effectifs (ReconcileSettingsService
 *     = même vrai singleton utilisé par le moteur, pas une copie locale) ;
 *   - chaque réveil relit les settings (évolution dynamique sans redémarrage : un
 *     administrateur peut basculer enabled/scanIntervalMs sans relancer l'API) ;
 *   - aucun scan immédiat au démarrage : premier réveil après scanInterval ;
 *   - jamais deux balayages simultanés : si l'observation précédente est encore en vol,
 *     l'expiration suivante est ignorée (le réveil qui arrive pendant une observation
 *     n'en démarre PAS une seconde) ;
 *   - jamais de boucle automatique sur erreur : une erreur de settings/observation est
 *     loggée (sans secret) puis le timer est replanifié à un intervalle sûr — pas de
 *     micro-ralenti ni de tour de boucle instantané ;
 *   - à l'arrêt / au shutdown : aucune nouvelle planification après stopping, le timer
 *     en cours est annulé, et on attend l'observation déjà en vol (jamais une 2e).
 *
 *  Frontière d'architecture (rapport 17B.4C2) : ce service est la SEULE classe du
 *  dépôt qui possède un timer/une boucle d'intervalle. Il ne touche ni Prisma, ni le
 *  transport panel (Coolify/Hestia), ni process.env, ni le domaine métier : il dépend
 *  uniquement de la façade ReconcileService (scanOnce) et de ReconcileSettingsService.
 */

export const RECONCILE_RUNNER_FALLBACK_INTERVAL_MS = RECONCILE_DEFAULT_SETTINGS.scanIntervalMs;

@Injectable()
export class ReconcileRunnerService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly log = new Logger(ReconcileRunnerService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  /** Détermine si une observation est réellement en vol (Promise résolue seulement à la fin).
   *  Jamais « false » tant que la Promise du scan n'est pas résolue : c'est la garantie
   *  « pas de 2e scan tant que le 1er dure » — pas un flag posé puis retombé à la main. */
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly engine: ReconcileService,
    private readonly reconcileSettings: ReconcileSettingsService,
  ) {}

  /**
   * Démarrage (après bootstrap complet) : ne lance AUCUN scan immédiatement.
   * Planifie uniquement le premier réveil à l'intervalle courant des settings.
   */
  async onModuleInit(): Promise<void> {
    if (this.stopping) return;
    const settings = await this.readSettingsSafe();
    this.scheduleNext(settings.scanIntervalMs);
  }

  /**
   * À l'arrêt de l'application : casse la boucle, annule le timer en attente, puis
   * attend — sans jamais en lancer une seconde — l'observation déjà en vol.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const flight = this.inFlight;
    if (flight) {
      // Le moteur scanOnce ne reject jamais (il gère ses propres erreurs) ; on reste
      // néanmoins robuste face à un rejet inattendu pour ne pas faire tomber le shutdown.
      try {
        await flight;
      } catch {
        this.log.warn('reconcile-runner: observation terminée en erreur pendant l\'arrêt (déjà propagée)');
      }
    }
  }

  /** Alias Nest pour le shutdown applicatif : même contrat que onModuleDestroy. */
  async onApplicationShutdown(): Promise<void> {
    await this.onModuleDestroy();
  }

  /**
   * Procédure lancée par chaque expiration du timer. Relit les settings effectifs,
   * puis :
   *   - enabled=false           → replanifie au prochain intervalle, pas de scan ;
   *   - observation en vol      → ignore cette expiration (pas de 2e scan) ; la boucle
   *                               se re-plannifie à la résolution de l'observation ;
   *   - sinon                   → scanOnce exactement une fois puis replanifie.
   * Les erreurs sont absorbées (warn sans secret) et la replanification se fait toujours
   * à un délai sûr (jamais un micro-timer ni un tour de boucle immédiat).
   */
  private async onWake(): Promise<void> {
    if (this.stopping) return;
    const settings = await this.readSettingsSafe();

    if (!settings.enabled) {
      this.scheduleNext(settings.scanIntervalMs);
      return;
    }

    if (this.inFlight) {
      // Expiration arrivée pendant une observation : on ne démarre RIEN. Le réveil
      // déclenché par la fin de l'observation (dans l'await ci-dessous) replanifiera.
      this.log.debug(
        'reconcile-runner: expiration ignorée — observation déjà en vol (anti-chevauchement)',
      );
      return;
    }

    this.startScan();
  }

  /**
   * Lance UNE observation, de manière à ce que la prochaine planification n'ait lieu
   * qu'après la résolution réelle de la Promise (et seulement si on n'est pas en arrêt).
   * Le flag inFlight n'est sincèrement levé qu'à la résolution — jamais avant — pour que
   * la fenêtre « pas de 2e scan tant que la 1re dure » soit réellement couverte.
   */
  private startScan(): void {
    const next = (async () => {
      try {
        await this.engine.scanOnce();
      } catch {
        // Message STRICTEMENT statique : jamais message/name/propriétés de
        // l'exception (une erreur peut embarquer des secrets — cf. spec 7-10, 12).
        this.log.warn('reconcile-runner: scanOnce en échec');
      } finally {
        // On retire le flag UNIQUEMENT ici, après résolution réelle de la Promise.
        this.inFlight = null;
        if (!this.stopping) {
          // Replanification À UN DÉLAI SÛR (intervalles des settings relus) —
          // JAMAIS de réveil immédiat : pas de tour de boucle instantané après
          // un scan réussi ou échoué.
          const settings = await this.readSettingsSafe();
          this.scheduleNext(settings.scanIntervalMs);
        }
      }
    })();
    // Pose du flag AVANT tout await de next : le premier await laisse passer le cas
    // de chevauchement puisque inFlight est déjà non-null.
    this.inFlight = next;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    const safeDelay = Math.max(RECONCILE_RUNNER_FALLBACK_INTERVAL_MS, delayMs);
    this.timer = setTimeout(() => {
      void this.onWake();
    }, safeDelay);
  }

  /**
   *  Relit les settings effectifs via le même vrai singleton que le moteur. En cas
   *  d'erreur de lecture (ex. DB indisponible au tout premier boot), on replie sur des
   *  valeurs sûres canoniques et on loggue un warning STATIQUE (aucune donnée issue
   *  de l'exception — jamais message, name ou propriété de l'erreur).
   */
  private async readSettingsSafe(): Promise<ReconcileSettings> {
    try {
      return await this.reconcileSettings.getSettings();
    } catch {
      // Message STRICTEMENT statique : aucune donnée issue de l'exception.
      this.log.warn('reconcile-runner: lecture des réglages en échec');
      return { ...RECONCILE_DEFAULT_SETTINGS };
    }
  }
}
