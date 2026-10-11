# GO — CORRIGER LES TROIS ÉCARTS RÉSIDUELS DE LA V3 — UN SEUL ARRÊT FINAL

Sauvegardé intégralement le 11/10/2026 depuis le message owner. Après interruption : relire
CE fichier, `recette/ETAT-REPRISE.md`, `docs/MATRICE-SUIVI-REVUE-V2.md` et vérifier l'état
réel des fichiers.

Conserver tout le travail existant. Ce GO porte uniquement sur les trois défauts ci-dessous
et leurs preuves. Aucun commit/merge/push, paiement réel, appel Stripe externe ou migration live.

## 1. EXCLUSION DES DISPATCHS ET RÉPONSES TARDIVES

Dans CardPaymentsService.dispatchCheckout, NOT_RESOLVED accepte actuellement DISPATCHED : deux travailleurs peuvent donc envoyer simultanément la même opération. Le chemin claimed.count !== 1 peut également continuer vers le réseau.

Implémenter une acquisition atomique réellement exclusive, avec identification du propriétaire ou de la génération de tentative. Toute écriture de résultat doit être conditionnée à cette identité. Une acquisition refusée ne doit jamais émettre d'appel.

Préserver la clé d'idempotence et le premier dispatchedAt. Prévoir une reprise bornée après interruption, sans transformer un résultat inconnu en échec certain. Ne pas classer un conflit de requêtes uniquement à partir de son statut HTTP comme preuve d'absence de création.

Vérifier et corriger le même problème dans CardRefundsService.enterDispatch : le verrou se termine avant le réseau et une seconde invocation peut repartir sur un remboursement déjà envoyé.

Tests déterministes : bloquer le premier appel simulé, lancer une seconde invocation, prouver un seul dispatch ; couvrir une réponse tardive et le scénario conflit concurrent puis succès. Aucun succès prestataire ne doit être perdu au profit d'un FAILED injustifié.

## 2. CONFIGURATION EXACTEMENT TESTÉE

Dans PaymentProviderService.checkConnection, resolve() construit le connecteur avant la lecture du snapshot « before ». Une modification entre ces deux opérations permet d'attribuer à B le résultat obtenu avec A.

Construire le connecteur et la condition de mise à jour depuis un seul snapshot cohérent. Toute modification pertinente de configuration doit invalider l'enregistrement de la preuve, succès comme échec.

Ajouter un test pilotant précisément la modification entre la résolution du connecteur et la lecture actuellement utilisée comme snapshot, ainsi qu'une modification pendant verifyAccount.

## 3. IDENTITÉ SOURCE DURABLE DES WEBHOOKS

PaymentWebhookEvent ne conserve pas le compte marchand source ; reconcileDue() appelle currentIdentity() et réinterprète ainsi l'événement avec la configuration courante.

Capturer et persister l'identité authentifiée à la réception : fournisseur, compte marchand, environnement et référence/version de configuration nécessaire. La vérification de signature et cette identité doivent provenir d'un contexte cohérent.

Toutes les reprises utilisent cette identité enregistrée. Aucun rattachement à une nouvelle configuration active. Pour un ancien événement sans preuve suffisante, prévoir un traitement conservateur explicite et visible, sans inventer son origine ni le perdre silencieusement.

Tester : réception sous A, événement en attente, changement vers B, reprise ; doublon après changement ; interruption après inscription durable. Prouver qu'aucun effet n'est attribué à B.

## VALIDATION ET LIVRAISON

- Tests sur bases isolées identifiées, transport simulé et barrières contrôlant réellement les intercalages.
- Corriger les éventuelles régressions dans ce périmètre ; validations ciblées puis consolidation adaptée au code final.
- Rectifier les rapports : distinguer preuve statique, simulation, PostgreSQL et Stripe test réel. Ne pas annoncer une exclusion ou une identité durable non démontrée.
- Mettre à jour le HTML, le rapport, les critères et ETAT-REPRISE.
- Fournir une archive REVUE-CLOTURE-PAIEMENTS-V4.zip sur le Bureau, avec patches complets, SHA-256, tests, résultats et limites.
- Sauvegarder ce GO intégral sur disque avant de commencer pour permettre une reprise après coupure.

Continuer de manière autonome jusqu'au rapport unique final. Les tests Stripe réels et l'activation en production restent des étapes distinctes, non autorisées ici.
