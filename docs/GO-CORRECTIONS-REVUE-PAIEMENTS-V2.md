# GO INTÉGRAL — CORRECTIONS DES ÉCARTS CONFIRMÉS PAR LA REVUE — CODE DIALI

> Sauvegardé intégralement le 10/10/2026 depuis le message owner (texte rétabli après
> compactage). Après interruption : relire CE fichier, `recette/ETAT-REPRISE.md`
> (référence chemin absolu + matrice de suivi) et vérifier l'état réel des fichiers.

Ce message rétablit le GO complet perdu après compactage. Il contient les SEPT points à traiter.

AVANT TOUTE MODIFICATION :
- Enregistre intégralement ce message dans docs/GO-CORRECTIONS-REVUE-PAIEMENTS-V2.md.
- Référence ce fichier avec son chemin absolu dans recette/ETAT-REPRISE.md.
- Crée une matrice de suivi des sept points et sous-points, distinguant code présent, vérification effectuée, preuve et reste à faire.
- Après toute interruption, relis ces deux documents et vérifie l'état réel des fichiers.

CONTINUITÉ :
Branche attendue feat/stripe-test, HEAD b01951b. Préserve toutes les modifications et fichiers non suivis existants. Aucun reset, restore, clean ou stash. Inspecte les corrections déjà présentes avant de les compléter : ne les réimplémente pas inutilement.

Le point 5d est annoncé implémenté. Conserve-le, mais distingue compilation réussie et comportement réellement testé. Un repli mémoire disparaît lors d'un rechargement complet : il ne prouve pas, seul, l'absence de nouvelle intention après interruption.

PÉRIMÈTRE ET AUTONOMIE :
Traite les sept points jusqu'au dossier final, sans demander de validation intermédiaire pour les choix techniques ordinaires. Aucun commit, merge, push, appel Stripe externe, paiement réel, migration live ou activation de production. Bases isolées et transports simulés uniquement. Aucun nettoyage forcé des preuves historiques.

## 1. COMPTABILISATION DES REMBOURSEMENTS DISTINCTS

Dans refund-accounting.ts, max(courant, somme interne, montant observé) évite certains doublons mais ne calcule pas correctement l'union des remboursements distincts.

Contre-exemples à reproduire :
a) Deux refund.updated externes SUCCEEDED distincts de 300 puis 400, avant charge.refunded cumulatif : attendu 700, actuellement 400.
b) Remboursement externe 300 déjà observé, puis remboursement interne distinct 400 : attendu 700, actuellement 400.

Distinguer durablement les identités des remboursements et les observations cumulatives. Ne jamais traiter le montant individuel de refund.* comme un cumul de charge. Si une observation ne permet pas un calcul exact, conserver explicitement l'incertitude et rapprocher avant d'autoriser une opération dépendant du plafond.

Tester doublons, ordres inversés, plusieurs remboursements internes/externes, arrivée avant la référence locale, concurrence et réservations. Aucun mouvement wallet pour un remboursement de commande payée directement par carte.

## 2. IDENTITÉ ET ROTATION DE CONFIGURATION

a) PaymentProviderService :
- currentIdentity() et resolveFor() utilisent encore verified ?? declared : supprimer l'autorisation fondée sur la seule déclaration.
- checkConnection() capture actuellement updatedAt APRÈS verifyAccount(). Capturer la version exacte de la configuration utilisée AVANT le réseau et conditionner l'écriture de la preuve à cette version.
- Tester : clé A utilisée, rotation vers B pendant l'appel, retour de la preuve A. Cette preuve ne doit jamais valider B.

b) Webhooks :
- Les chemins remboursement, litige et certaines transitions ne filtrent que providerCode ou providerRef.
- Vérifier fournisseur + compte marchand + environnement contre l'identité d'origine de l'opération.
- Conserver l'identité authentifiée lors de la réception pour les rapprochements ultérieurs, sans la remplacer par la configuration courante.

## 3. DISPATCH, REPRISES ET WEBHOOKS DURABLES

Dans dispatchCheckout(), le updateMany sur dispatchedAt ne constitue pas une exclusion : son résultat est ignoré, puis tous les appelants peuvent émettre. enterDispatch() des remboursements laisse également repartir une opération déjà dispatchée sans référence.

Mettre en place une acquisition conditionnelle et une protection des écritures tardives :
- deux appels concurrents ne doivent pas émettre librement la même opération ;
- un échec tardif ne doit pas écraser une réussite déjà persistée ;
- premier dispatchedAt immuable ;
- reprise des remboursements également bornée, sans réémission aveugle après expiration de la garantie d'idempotence ;
- classifier les erreurs selon leur signification : ne pas supposer que tout autre HTTP 4xx prouve l'absence d'opération.

Le sweep ne sélectionne actuellement que RECEIVED avec reconcileAt <= now. Couvrir aussi le crash après insertion d'un événement RECEIVED avant attribution de reconcileAt. Un rapprochement épuisé sans paiement rattaché doit rester consultable par l'admin.

Tests avec barrières contrôlées, compteurs d'appels et réponses intercalées.

## 4. GARDE SOLDE ET DÉSACTIVATION DES MOYENS

a) payOrderWithWallet() ne bloque que les cartes CREATED/PROCESSING. Bloquer également une issue carte non résolue, notamment NEEDS_REVIEW, avant tout débit.

b) Sur refreshFromProvider(), une première émission vérifie l'interrupteur mais pas assertCardMethodActive(). Appliquer les mêmes contrôles du moyen effectivement utilisé à toutes les premières émissions.

c) Vérifier la désactivation concurrente et conserver la possibilité de constater/rembourser les opérations déjà émises.

## 5. PARCOURS CLIENT ET ADMIN RÉELLEMENT UTILISABLES

5a — Choix au checkout :
Proposer un vrai choix « Solde du portefeuille / Carte bancaire » sur l'étape de paiement, selon les capacités. Un client avec du solde doit pouvoir acheter lorsque carte et virements sont désactivés, sans choisir artificiellement un autre moyen. Aucun paiement mixte.

5b — Capacités :
Les capacités doivent refléter disponibilité opérationnelle, moyen actif et devise, pas seulement les trois interrupteurs. Aligner cardProviderStatus() sur le connecteur réellement résolu. Chargement ou erreur des capacités : aucun moyen présumé disponible.

5c — Remboursement admin :
Le bouton admin de remboursement doit distinguer ORDER et TOPUP. Pour ORDER, appeler le parcours de remboursement de commande vers sa carte, sans débit wallet. Le test précédent contournait ce défaut par un POST direct : corriger puis tester le bouton jusqu'au statut SUCCEEDED.

5d — Intention navigateur :
TopupAttempt doit être lié au client, au parcours, au montant et à la devise. Conserver les changements déjà réalisés dans api.ts et la page portefeuille.

Vérifier changement de compte, ancien format, fermeture/réouverture, perte réseau et stockage indisponible. Une opération non résolue ne doit pas être contournée par une nouvelle clé après rechargement ou perte de la mémoire du navigateur. La protection serveur doit compléter le stockage client.

## 6. PREUVES ET OUTILLAGE

a) Concurrence :
Ne pas présenter les tests séquentiels C1/C2 de order-card-payment comme une course : la carte est ouverte dans beforeAll, puis le solde est essayé ensuite.

Ajouter les courses réellement demandées, avec synchronisation observable. Le test refund-accounting précédent lançait deux charge.refunded identiques ; il ne prouvait pas la course charge.refunded contre refund.updated.

b) Navigateur :
Exécuter un paiement par solde, une carte directe, une recharge et un remboursement via l'interface admin. Afficher le portefeuille ne constitue pas un test de paiement par solde.

L'absence de runner de tests web ne dispense pas des contrôles navigateur déjà utilisés dans recette/.

c) Isolation :
Avant les mutations du parcours, prouver que l'API ciblée utilise la même base isolée que Prisma.

d) Processus :
Pour down.ps1, un fragment générique dist/src/main.js ou dist/bin/next ne prouve pas l'appartenance à la recette. Vérifier l'identité de lancement et le worktree ; refuser une entrée inconnue ou un PID réutilisé.

## 7. CLÔTURE DOCUMENTAIRE ET LIVRAISON UNIQUE

a) Actualiser les critères selon les preuves exactes. Aucun [V] pour un scénario non exercé. Mettre à jour rapport, HTML, PROJECT_STATUS.md et ETAT-REPRISE.md.

b) Rectifier les documents :
- marque publique : Code Diali ; entité : Code Diali LLC ;
- Stripe déjà choisi, PaymentCloud ultérieurement ;
- distinguer simulation, Stripe test et activation live ;
- ne pas proposer de déployer b01951b sans les corrections encore non committées ;
- compléter le retour arrière avec le rapprochement des paiements intervenus après une sauvegarde : une restauration DB ne doit pas faire perdre leur suivi.

c) Validation :
Effectuer les tests ciblés nécessaires, puis une consolidation finale sur le code exact. Ne pas répéter les validations inchangées pendant chaque sous-étape. Conserver séparément les preuves desktop/mobile et les journaux.

d) Archive finale :
L'archive V2 de 43 821 octets remise après la reprise est PARTIELLE : la conserver comme preuve de reprise, sans la présenter comme clôture globale.

À la fin des sept points, produire REVUE-CLOTURE-PAIEMENTS-V3.zip sur mon Bureau Windows réel, contenant :
- le présent GO intégral ;
- rapport des sept points : défaut, correction, fichiers, preuve, limites ;
- critères actualisés, guide Stripe test et checklist production ;
- patch complet et delta depuis l'état examiné lors de la revue, avec bases identifiées et SHA-256 ;
- scripts actualisés et dépendances locales nécessaires, sans secrets ;
- résultats et captures desktop/mobile ;
- état Git exact et liste des blocages externes.

Si l'état initial du delta n'est pas reconstituable avec certitude, le signaler : ne pas inventer de base.

Donner le chemin absolu de l'archive. Un seul arrêt final pour revue. Si un constat est contesté, fournir la reproduction exacte et la preuve contraire ; un commentaire de code ou une compilation réussie ne suffit pas à clore un défaut fonctionnel.
