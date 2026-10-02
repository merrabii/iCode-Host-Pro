import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentMethodType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isPaymentSimulatorEnabled } from '../config/payment-simulator';

/**
 * PUBLIC — moyens de paiement actifs pour le tunnel checkout (Bloc C).
 * Renvoie UNE VUE PUBLIQUE (id, name, type, config NON secrète). Le champ
 * `config` des méthodes actives porte les coordonnées bancaires / instructions
 * d'affichage. `configEnc` (secrets carte) n'est JAMAIS renvoyé (§7).
 * Carte : masquée honnêtement tant qu'aucun adaptateur réel n'est configuré
 * (aucun prestataire choisi) — visible uniquement sous simulateur de recette
 * explicitement activé.
 */
@ApiTags('store/payment-methods')
@Controller('store/payment-methods')
export class PaymentMethodsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Méthodes de paiement actives (publiques, sans secrets)' })
  async listActive() {
    const simulator = isPaymentSimulatorEnabled();
    const methods = await this.prisma.paymentMethod.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: {
        id: true,
        name: true,
        type: true,
        isActive: true,
        config: true,
      },
    });
    // Vue lisible : on ne renvoie que les champs publics (jamais configEnc),
    // et on masque la carte tant que personne ne peut réellement la traiter.
    return methods
      .filter((m) => m.type !== PaymentMethodType.CARD || simulator)
      .map((m) => ({
        id: m.id,
        name: m.name,
        type: m.type,
        config: m.config,
      }));
  }
}