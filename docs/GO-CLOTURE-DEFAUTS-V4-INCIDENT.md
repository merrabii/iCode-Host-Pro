# GO — FERMETURE DES DEUX DÉFAUTS V4 + CLARIFICATION DE L'INCIDENT — UN ARRÊT FINAL

Conserver le travail existant. Aucun commit/merge/push, appel Stripe réel, paiement réel ou nouvelle écriture sur icode_host_pro.

## 1. RÉPONSE TARDIVE APRÈS CONFIRMATION WEBHOOK

Dans CardPaymentsService, les écritures de dispatch sont maintenant conditionnées à dispatchOwner, mais les confirmations webhook passent providerCallState à RESOLVED sans invalider ce propriétaire.

handleDispatchFailure peut donc encore :
- remettre un paiement confirmé en UNCERTAIN après un timeout ;
- écrire FAILED après une confirmation SUCCEEDED, sans annuler le crédit déjà enregistré.

Corriger la coordination entre dispatch, confirmation webhook et autres chemins terminaux : une réponse tardive ne doit jamais dégrader une décision métier déjà établie. Les conditions d'écriture doivent vérifier le propriétaire ET l'état admissible ; invalider la revendication lorsque nécessaire.

Tests déterministes sur TOPUP et ORDER :
- appel suspendu → webhook confirme → réponse réseau timeout ;
- appel suspendu → webhook confirme → réponse de refus ;
- appel suspendu → webhook confirme → réponse de succès.
Vérifier statut, providerCallState, références, crédit ou commande, absence de nouveau blocage client et absence de double effet. Conserver les tests de concurrence entre propriétaires.

## 2. IDENTITÉ WEBHOOK PERSISTÉE ATOMIQUEMENT

handleSignedPayload crée actuellement l'événement via dedupe(), puis écrit son identité dans une seconde opération dont l'erreur est absorbée par catch(() => undefined).

Rendre atomique l'inscription durable de l'événement et de son identité source authentifiée. Aucun effet métier ni acquittement de succès si cette persistance échoue.

Préserver la déduplication et l'identité d'origine lors des doublons. Les événements historiques sans identité restent explicitement distingués des événements nouveaux.

Tests :
- échec injecté de persistance → aucun dispatch métier, réponse permettant un rejeu ;
- interruption juste après inscription durable → événement complet, reprise possible sous l'identité d'origine ;
- rotation A→B puis doublon/reprise → aucune réattribution à B.

## 3. INCIDENT SUR icode_host_pro — PREUVES ET PRÉVENTION

Ne procéder à aucune nouvelle réparation ou écriture sur cette base.

Documenter les six migrations concernées, les commandes d'application et d'inversion réellement exécutées, les contrôles disponibles et leur chronologie. Joindre les journaux existants, sans secrets. Corriger la date si nécessaire.

Distinguer explicitement :
- ce qui est démontré par des preuves conservées ;
- ce qui est seulement déclaré ;
- ce qui n'est plus vérifiable faute d'état antérieur.

Retirer « base non touchée » et « tous les interdits respectés ». Le retour arrière n'efface pas l'incident.

Ajouter aux commandes/scripts de migration de recette utilisés une garde obligatoire vérifiant l'identité réelle de la base et une liste explicite des bases isolées autorisées. Pas de repli implicite vers le DATABASE_URL du .env. Tester le refus sur une cible non autorisée sans y exécuter de migration.

## VALIDATION ET LIVRAISON

Tests ciblés avec intercalages contrôlés, PostgreSQL isolé pour les garanties transactionnelles, puis validations adaptées au code final. Aucun affaiblissement d'assertion.

Mettre à jour rapports, HTML, critères et ETAT-REPRISE avec les résultats réellement obtenus et les limites restantes.

Sauvegarder ce GO intégral avant de commencer. Produire sur le Bureau REVUE-CLOTURE-PAIEMENTS-V5.zip avec patches complets, SHA-256, preuves des deux corrections et dossier d'incident.

Continuer de manière autonome jusqu'à un unique rapport final. Ne pas ouvrir d'autre chantier.
