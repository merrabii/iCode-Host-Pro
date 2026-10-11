# GO — DERNIÈRE CORRECTION CIBLÉE IDENTIFIÉE DANS LA V6

Conserver les corrections validées : réponses tardives, acquisition des dispatchs, snapshot de configuration et création atomique des nouveaux webhooks. Ne pas rouvrir ces chantiers.

## 1. REPRISE WEBHOOK SANS IDENTITÉ DURABLE

Défaut reproduit dans payment-webhook.service.ts :

- dedupe() retrouve une ligne RECEIVED/FAILED sans merchantAccount ;
- l’updateMany de complétion échoue mais son erreur est absorbée ;
- la relecture peut également échouer et revenir à existing ;
- handleSignedPayload utilise sourceIdentity ?? auth.identity ;
- le traitement métier continue et renvoie 200 sans identité persistée.

Corriger ce chemin :
- aucune erreur de persistance ou de relecture nécessaire à la preuve ne doit être absorbée ;
- contrôler le résultat du CAS et relire l’identité effectivement enregistrée ;
- le dispatch doit utiliser exclusivement cette identité durable, jamais un repli vers la configuration courante ;
- si une complétion historique ne peut pas être justifiée par le rejeu authentifié, refuser explicitement et conserver l’événement pour intervention ;
- aucune réattribution d’une identité déjà présente.

Tests ciblés :
a) ancienne ligne sans identité + écriture refusée → zéro effet métier, réponse permettant un rejeu ;
b) écriture/relecture interrompue → aucune poursuite sans preuve durable ;
c) course de complétion → identité réellement enregistrée utilisée, jamais celle du perdant ;
d) reprise nominale et doublon → idempotence conservée.

## 2. RECTIFICATION DU DOSSIER D’INCIDENT

Les fichiers check-dev-db.sql et revert-dev-db.sql sont des scripts : seuls, ils ne prouvent pas leurs résultats d’exécution.

Remplacer les conclusions absolues « impact métier : aucun », « base revenue à son état antérieur » et « désormais empêché » par des formulations limitées aux preuves disponibles.

Conserver clairement :
- l’incident déclaré ;
- les contrôles et résultats effectivement conservés ;
- l’absence de sauvegarde préalable ;
- l’impossibilité de certifier une identité complète avant/après ;
- la garde protège les chemins qui l’appellent, pas une commande Prisma directe.

Aucune nouvelle écriture ou tentative de réparation sur icode_host_pro. Ne pas inventer de journal manquant.

## LIVRAISON

Sauvegarder ce GO, effectuer la correction et les tests affectés, puis actualiser rapport, critères, HTML et ETAT-REPRISE.

Fournir REVUE-CLOTURE-PAIEMENTS-V6.zip sur le Bureau, avec patches complets, SHA-256 et preuves ciblées. Un seul arrêt final.

Aucun commit/merge/push, paiement réel, appel Stripe externe ni migration live.
