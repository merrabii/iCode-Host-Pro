# GO — CLÔTURE DES PAIEMENTS ET PRÉPARATION À LA PRODUCTION — CODE DIALI

> Sauvegardé intégralement le 08/10/2026 depuis le message owner (texte de référence
> du chantier de clôture). Après interruption : relire CE fichier, `recette/ETAT-REPRISE.md`
> et `docs/GO-CLOTURE-CRITERES.md` (suivi des critères §2-§9).

Voici le GO intégral à conserver et exécuter.

**Avant de poursuivre :**
- Sauvegarde ce message intégral dans `docs/GO-CLOTURE-PAIEMENTS.md`.
- Référence ce fichier dans `recette/ETAT-REPRISE.md`, avec les étapes terminées, en cours et restantes.
- Après toute interruption ou réduction du contexte, relis ces fichiers et vérifie l'état réel du travail.
- Conserve les modifications déjà réalisées. Ne recommence pas les étapes prouvées terminées et ne relance pas leurs validations sans raison.
- Ce message consolide le GO précédent et ses compléments. Il ne demande pas de repartir de zéro.

**Objectif :** terminer les corrections des paiements et préparer une mise en production vérifiable, avec **un seul arrêt final pour revue**. Aucune nouvelle fonctionnalité hors du périmètre ci-dessous.

Marque publique : **Code Diali**. Entité juridique : **Code Diali LLC**. Conserver les chemins techniques existants sans chantier de renommage.

## 1. Reprendre et préserver l'existant

Dernier état connu : branche `feat/stripe-test`, HEAD `b01951b`, avec le lot paiement direct/réglages admin non committé. Vérifie l'état actuel avant toute action et préserve aussi les corrections éventuellement réalisées depuis ce constat.

Périmètre figé :
- paiement des commandes par solde ;
- paiement direct par carte Stripe, sans passage par le portefeuille ;
- recharge du portefeuille par carte ;
- virements existants ;
- gestion administrative des moyens de paiement.

Transforme les points 2 à 9 en critères d'acceptation suivis dans un document. Une fonctionnalité ajoutée ne remplace pas la résolution d'un défaut de revue.

## 2. Corriger la comptabilisation des remboursements

Un remboursement doit être comptabilisé une seule fois, quelle que soit la source : réponse API, webhook, rejeu ou rapprochement.

Reproduire puis corriger :
- remboursement de 1 000 centimes → `charge.refunded` → `refund.updated` du même remboursement : total final **1 000**, jamais 2 000 ;
- ordre inverse, événements dupliqués et traitements concurrents ;
- webhook reçu avant la persistance de la référence locale ;
- remboursement inconnu `pending`, `failed` ou `canceled` : ne jamais le compter comme réussi ;
- plusieurs remboursements partiels, internes et externes.

Utiliser une identité de remboursement non ambiguë, liée au fournisseur, au compte et à l'environnement. Garantir la cohérence des réservations, des cumuls et des compensations.

Un paiement direct par carte et son remboursement ne créent aucun mouvement de portefeuille. Le remboursement suit le paiement d'origine.

## 3. Imposer une identité prestataire réellement vérifiée

Un compte marchand déclaré par l'administrateur ne constitue pas une preuve de vérification.

Lier la vérification à la configuration exacte utilisée. Toute modification des éléments pertinents invalide les preuves devenues obsolètes. Un contrôle commencé avant un changement ne peut pas valider une nouvelle configuration.

Appliquer les vérifications fournisseur, compte marchand, environnement et rattachement de l'opération aux créations, reprises, confirmations, remboursements, litiges et webhooks.

Les opérations existantes restent liées à leur identité d'origine. Une configuration active différente ne doit jamais les réaffecter silencieusement.

## 4. Sécuriser les reprises et le rapprochement

- Conserver une date de premier dispatch immuable pour les paiements et remboursements.
- Ne pas prolonger la fenêtre de reprise en réécrivant cette date à chaque tentative.
- Encadrer les appels concurrents et les réponses tardives, sans appel réseau sous transaction longue.
- Ne pas classer indistinctement tous les HTTP 4xx comme des échecs définitifs.
- Ne pas réémettre automatiquement une opération incertaine lorsque la sûreté de cette reprise n'est plus démontrable.
- Corriger le simulateur pour vérifier l'idempotence entre instances et après redémarrage, pas seulement dans une instance en mémoire.
- Assurer un rapprochement durable des webhooks non rattachés, y compris après arrêt du processus. Ne pas dépendre d'un nouvel événement fortuit ou d'un commentaire annonçant une reprise inexistante.
- Prévoir une issue observable pour les rapprochements épuisés, sans perte silencieuse.

Une opération incertaine ou `NEEDS_REVIEW` non résolue doit empêcher un nouveau règlement susceptible de doubler l'encaissement. Tester explicitement les courses solde/carte et carte/carte.

## 5. Terminer les réglages admin et leur application

Depuis l'interface admin, gérer indépendamment :
- paiement des commandes par solde ;
- paiement direct des commandes par carte ;
- recharge du portefeuille par carte ;
- virement pour les commandes et les recharges, selon les parcours existants.

Réutiliser les réglages existants lorsqu'ils suffisent, sans créer un système parallèle.

Exigences :
- Afficher au client uniquement les moyens activés et opérationnels pour le parcours et la devise.
- Appliquer cette règle au checkout, aux commandes, au portefeuille et aux pages de retour.
- En cas de chargement ou d'échec de lecture des capacités, ne pas présumer qu'un moyen est autorisé.
- Vérifier côté serveur les interrupteurs de parcours ainsi que le moyen effectivement utilisé, notamment son état `isActive`.
- Refuser les appels API directs qui contournent l'interface.
- Désactiver un moyen doit bloquer une première émission ou un nouveau débit, y compris via un endpoint de rafraîchissement.
- Continuer à recevoir et rapprocher les résultats des opérations déjà émises ; conserver les possibilités de remboursement.
- Rendre atomiques la modification administrative et son audit, avec auteur et anciennes/nouvelles valeurs exactes.
- Préserver le solde et l'historique lors d'une désactivation. Recharge et paiement par solde restent indépendants.
- Si aucun moyen n'est disponible, bloquer la validation avec un message clair ; aucun repli automatique.
- Ne pas activer de nouveau moyen automatiquement lors d'une migration.

Corriger la garde historique qui refuse le checkout carte lorsque le simulateur est désactivé : un connecteur Stripe test correctement configuré doit fonctionner sans simulateur.

Le checkout doit réellement proposer le choix solde/carte selon les capacités, sans imposer une recharge préalable. Aucun paiement mixte solde + carte dans ce lot.

## 6. Terminer les contrôles de devise et d'intention navigateur

USD par défaut, EUR pris en charge, sans mélange ni conversion implicite.

- Aucune opération du portefeuille ne doit contourner la garde de devise parce que sa devise est absente.
- Ne pas attribuer arbitrairement une devise à des mouvements historiques ambigus ni convertir silencieusement un solde.
- Documenter et tester le traitement conservateur des données historiques.
- Rattacher la tentative navigateur au client, au parcours, au montant et à la devise.
- Tester changement de compte, fermeture/réouverture, perte réseau, stockage navigateur indisponible et résultat incertain.
- Ne pas générer automatiquement une nouvelle intention qui contourne une opération non résolue.

## 7. Sécuriser les scripts avant de les réutiliser

Corriger les scripts de recette signalés avant toute exécution mutative :
- construire explicitement l'URL de la base cible, sans remplacement fragile dépendant de la présence de `?` ;
- vérifier `current_database()` avant toute mutation ;
- prouver que l'API testée et le client Prisma utilisent la même base ;
- utiliser des fixtures dédiées avec marqueur d'appartenance, jamais un nettoyage fondé uniquement sur l'email ;
- arrêter immédiatement sur erreur et ne jamais afficher un faux succès de nettoyage ;
- arrêter seulement les processus créés et identifiés par le script, pas tout occupant d'un port ;
- appliquer une garde réseau avant connexion, avec destinations autorisées explicites.

Préserver les comptes, les preuves et les ressources historiques. Aucun accès mutatif à la base habituelle ou à la production. Les migrations nécessaires sont autorisées uniquement sur les bases isolées identifiées ; ne pas réécrire les migrations déjà appliquées.

## 8. Valider les corrections et les parcours complets

Commencer par les reproductions ciblées, corriger, puis valider le code final. Ne pas affaiblir, ignorer ou supprimer une assertion pour obtenir du vert.

Pour les courses, utiliser PostgreSQL isolé et des barrières déterministes. Des appels successifs ne prouvent pas la concurrence.

Consolidation finale :
- validation Prisma ;
- typechecks API/Web ;
- builds API/Web ;
- tests des corrections et non-régressions nécessaires ;
- état Git et contrôles d'intégrité du diff.

Exécuter un parcours navigateur desktop et mobile :
- modification admin → affichage client → autorisation/refus API ;
- paiement par solde ;
- paiement direct par carte ;
- recharge distincte ;
- désactivation pendant un checkout ;
- retour de paiement et état réel de la commande ;
- remboursement effectivement conclu, avec vérification des montants.

Un remboursement seulement `PENDING` ne constitue pas une preuve de remboursement terminé.

Conserver des preuves datées et distinguer les tests exécutés sur le code final des résultats historiques non rejoués.

## 9. Préparer les validations externes et la production

Préparer un guide Stripe test distinct des scripts de simulation : configuration, événements nécessaires, succès/refus, authentification supplémentaire si applicable, retour navigateur, webhooks, remboursements et rapprochement.

Si les accès manquent, terminer tout le travail indépendant et fournir une liste unique des prérequis manquants. Aucun secret dans les messages, captures, rapports, patches ou archives.

Préparer la checklist de production :
- CI et version exacte à déployer ;
- configuration et secrets ;
- migrations et sauvegarde/restauration ;
- tâches de rapprochement et supervision ;
- essai d'hébergement réel contrôlé ;
- décisions restantes ;
- procédure de retour arrière.

La simulation n'équivaut ni à Stripe test ni à une validation de l'infrastructure réelle.

Ce GO n'autorise aucun nouvel appel vers Stripe ou un provider réel. Les essais externes seront autorisés séparément sur des environnements identifiés. Ne pas lever le refus live pour faire passer les tests.

## 10. Livrer un dossier unique de clôture

Mettre à jour :
- `docs/RAPPORT-STRIPE-TEST.md`
- `docs/suivi-projet.html`
- `PROJECT_STATUS.md`
- le guide de recette ;
- `recette/ETAT-REPRISE.md`
- le suivi des critères de ce GO.

Pour chaque point : défaut, correction, fichiers concernés, test exact, résultat, environnement et limite. Si un constat de revue est contesté, fournir une reproduction ou une preuve précise, pas seulement un commentaire.

Fournir :
- patch complet depuis `78b51ce`, incluant les fichiers neufs ;
- patch des seules corrections de ce GO, à partir d'un état initial explicitement identifié et préservé ;
- tailles, SHA-256 complets et contrôles de fidélité ;
- archive des scripts actualisés sans secrets ;
- résultats navigateur et captures ;
- chemins absolus de tous les livrables ;
- état Git exact et liste des blocages restants.

Laisser la recette accessible pour consultation, sans déclencher automatiquement des tests ou un nettoyage.

## Règles finales

Aucun commit, merge, push, migration live, paiement réel, activation de production, nettoyage forcé ni suppression de base.

Prendre les décisions techniques courantes nécessaires dans ce périmètre. Ne pas demander une validation intermédiaire pour chaque fichier ou correction. En cas de prérequis manquant, poursuivre tous les travaux indépendants et consigner le blocage.

**Un seul ARRÊT final pour revue consolidée, avec un rapport honnête sur ce qui est terminé et ce qui reste réellement bloquant.**
