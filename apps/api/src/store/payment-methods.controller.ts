import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentMethodType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentSettingsService } from './payment-settings.service';

/**
 * PUBLIC — moyens de paiement actifs pour le tunnel checkout (Bloc C).
 * Renvoie UNE VUE PUBLIQUE (id, name, type, config NON secrète). Le champ
 * `config` des méthodes actives porte les coordonnées bancaires / instructions
 * d'affichage. `configEnc` (secrets carte) n'est JAMAIS renvoyé (§7).
 * Q7 (GO item 7) : les frais du moyen (feeType/feePercent/feeFixedCents) sont
 * aussi exposés — ce sont des paramètres de GRILLE tarifaire publique
 * (affichés au client avant paiement), pas des secrets ; ils sont APPLIQUÉS
 * dans `buildPricing` (devis + commande), plus seulement journalisés.
 *
 * Lot « moyens de paiement » — le client ne voit QUE les moyens :
 *  - activés côté admin (`isActive`) ;
 *  - dont le PARCOURS correspondant est activé (règlement de commande par
 *    carte = `cardOrderPaymentEnabled`, interrupteur indépendant) ;
 *  - et techniquement configurés (simulateur de recette OU prestataire de
 *    test réel) — masquer ne remplace pas le gate serveur, qui reste appliqué
 *    à chaque création/débit.
 * Aucun repli automatique vers un autre moyen : liste vide = le client ne peut
 * pas valider (message + bouton bloqué côté UI).
 */
@ApiTags('store/payment-methods')
@Controller('store/payment-methods')
export class PaymentMethodsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PaymentSettingsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Méthodes de paiement actives (publiques, sans secrets)' })
  async listActive() {
    // GO revue §5b — UNE seule lecture effective (interrupteur ∩ ligne CARTE
    // ∩ connecteur réellement résolvable) pour filtrer la carte : jamais un
    // moyen affiché que le gate serveur refuserait ensuite.
    const caps = await this.settings.effectiveCapabilities();
    const methods = await this.prisma.paymentMethod.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: {
        id: true,
        name: true,
        type: true,
        isActive: true,
        config: true,
        feeType: true,
        feePercent: true,
        feeFixedCents: true,
      },
    });
    // Vue lisible : on ne renvoie que les champs publics (jamais configEnc),
    // et la carte uniquement si son PARCOURS commande est activé ET traitable.
    return methods
      .filter(
        (m) =>
          m.type !== PaymentMethodType.CARD ||
          (caps.cardOrderPaymentEnabled && caps.cardAvailable),
      )
      .map((m) => ({
        id: m.id,
        name: m.name,
        type: m.type,
        config: m.config,
        feeType: m.feeType,
        feePercent: m.feePercent !== null ? Number(m.feePercent) : null,
        feeFixedCents: m.feeFixedCents,
      }));
  }
}

/**
 * PUBLIC — disponibilité RÉELLE des parcours de paiement (masquage UI côté
 * client : bouton « Régler par solde », bloc « Payer par carte », recharge).
 * GO revue §5b : renvoie les interrupteurs BRUTS + la disponibilité
 * opérationnelle de la carte (connecteur réellement résolvable, ligne CARTE
 * active, devise) — un affichage « solde + carte » ne doit jamais proposer
 * une carte que le serveur refusera. La décision d'AUTORISATION reste
 * serveur : chaque opération re-passe par son gate.
 */
@ApiTags('store/payment-capabilities')
@Controller('store')
export class PaymentCapabilitiesController {
  constructor(private readonly settings: PaymentSettingsService) {}

  @Get('payment-capabilities')
  @ApiOperation({
    summary: 'Parcours de paiement activés + disponibilité carte (public)',
  })
  async capabilities() {
    return this.settings.effectiveCapabilities();
  }
}
