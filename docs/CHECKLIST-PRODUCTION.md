# Checklist — préparation à la production (GO clôture §9, C9.2)

> **Statut :** préparation, **pas** une autorisation de mise en production.
> Le GO clôture **n'autorise aucun** commit/merge/push, migration live, paiement réel ou
> activation production. Chaque case est à cocher **uniquement** après décision explicite du
> propriétaire, avec preuve datée.
> **Marque :** Code Diali (publique) · **Entité :** Code Diali LLC. **Prestataire paiement :**
> Stripe **déjà choisi** (mode test actuellement) ; PaymentCloud éventuellement **ultérieur**
> (option, GO distinct). **Simulation ≠ Stripe test ≠ activation live** : jamais confondus.
> **Version à déployer :** **`b01951b` seul n'est PAS déployable** — le lot de corrections
> paiements (dont les 7 points de la revue V2) est **non committé** ; tout déploiement exige
> d'abord le commit du **code exact de l'arbre** (sur ordre du propriétaire) ou la livraison
> de l'artefact complet construit depuis l'arbre, jamais le SHA nu sans ses corrections.

---

## 1. CI et version exacte à déployer

- [ ] **Lot non committé inclus** : le SHA déployé comprend les corrections paiements de
      l'arbre (revue V2 comprise) — **jamais `b01951b` nu** sans les corrections (elles
      n'étaient pas committées à ce SHA).
- [ ] SHA exact de la branche déployée **figé** (commit de merge/commit du lot autorisé) ;
      tag/annoté créé et poussé **uniquement** après autorisation.
- [ ] Pipeline CI vert sur ce SHA (build + tests ; ESLint absent localement = étape CI documentée).
- [ ] Artefact de build API (`dist`) et web (`.next`) produits **par la CI**, pas depuis une
      machine dev.
- [ ] Variables d'environnement de prod documentées et séparées du `.env` dev.

## 2. Configuration et secrets

- [ ] `DATABASE_URL` : base de production **neuve**, host/user/password fournis par
      l'infra (pas les identifiants dev/recette).
- [ ] `JWT_SECRET`, `ENCRYPTION_KEY` : valeurs neuves, fortes, **jamais** réutilisées en
      dev/recette ; stockées dans le secret manager du VPS/Coolify.
- [ ] `PUBLIC_API_BASE` / `NEXT_PUBLIC_*` : domaine public final.
- [ ] Clés Stripe **mode test** (si validation B avant go-live) ou **live** (seulement après
      GO live distinct) — toujours via `/manager/moyens-paiement`, jamais dans un fichier Git.
- [ ] Webhook Stripe : URL publique HTTPS, signing secret `whsec_` enregistré, **corps brut**
      préservé par le proxy.
- [ ] `NODE_ENV=production` (coupe le simulateur).
- [ ] Aucun secret dans le dépôt : `git grep` des préfixes `sk_`, `whsec_`, `DATABASE_URL=postgres://` → 0 hit hors exemples.

## 3. Migrations et sauvegarde/restauration

- [ ] **Sauvegarde complète** de la base cible **avant** toute migration (pg_dump horodaté,
      stockage hors VPS).
- [ ] `prisma migrate deploy` (jamais `migrate dev` en prod) — 64 migrations, ordre vérifié.
- [ ] `prisma migrate status` = up to date **après** déploiement.
- [ ] Procédure de **restauration testée** au moins une fois (pg_restore sur base de test).
- [ ] Rollback DB documenté (§7 ci-dessous).

## 4. Tâches de rapprochement et supervision

- [ ] Sweep de rapprochement actif (`reconcile.runner`, défaut 60 s) — jamais désactivé (`0`)
      en prod sans décision.
- [ ] Surveillance des interventions admin (`/manager/paiements-carte`, interventions ouvertes).
- [ ] Alertes minimales : erreur webhook 5xx, `UNCERTAIN`/`NEEDS_REVIEW` persistants, disque
      base, process API/web.
- [ ] Logs structurés conservés ≥ 30 jours (paiements, webhooks, remboursements).
- [ ] Sauvegarde quotidienne automatisée + rétention définie.

## 5. Essai d'hébergement réel contrôlé

- [ ] Déploiement de la **plateforme** comme app packagée (checklist CLAUDE.md : projet Coolify
      isolé, VPS dédié **séparé** des apps clients, base neuve).
- [ ] Démarrage + migrations + santé (`/api/health`) validés.
- [ ] Installateur web (host/user/password PG) testé sur base neuve — seulement à la fin du
      développement (CLAUDE.md §Rappel).
- [ ] Commande serveur-vierge testée (si développée).
- [ ] Aucune opération déployée sur le/des serveur(s) d'apps clients.

## 6. Décisions restantes (bloquantes avant live)

- [ ] **Décision provider** (GO §6-1) : Stripe live ou autre — catégorie B live = GO distinct.
- [ ] Effet infra suspension (§6-4).
- [ ] Numérotation annuelle (§6-6).
- [ ] Exécution RGPD + switch inscription gratuite (§6-7).
- [ ] Validation owner de chaque case de cette checklist.

## 7. Procédure de retour arrière

1. **Stopper** le reverse proxy / désactiver le domaine public.
2. **Restaurer** la sauvegarde DB (pg_restore) si une migration a corrompu les données.
3. **Rapprocher les paiements intervenus APRÈS la sauvegarde** : une restauration fait
   **perdre** le suivi des paiements/remboursements/webhooks survenus entre la sauvegarde et
   l'incident — les **exporter avant** restauration (ou depuis les journaux provider) puis
   après restore : rejouer/importer les événements manquants, revérifier `CardPayment` /
   `Refund` / `RefundObservation` contre le journal provider, et **réouvrir une intervention
   admin** pour tout montant non rattaché (jamais de perte silencieuse de suivi).
4. **Redéployer** l'artefact précédent (tag Git précédent) via Coolify — artefact contenant
   les corrections paiements, jamais un SHA dégradé sans elles.
5. **Vérifier** `/api/health` + login + une commande simple.
6. **Journaliser** l'incident (date, cause, état restauré, opérations rapprochées).
7. **Ne jamais** exécuter `migrate down` en prod sans sauvegarde validée + double validation.

---

## Rappels permanents (GO clôture)

- Marque publique **Code Diali** ; entité **Code Diali LLC**.
- Prestataire : **Stripe déjà choisi** (test en cours) ; **PaymentCloud** éventuellement
  **ultérieur** (option, décision distincte). Ne jamais présenter PaymentCloud comme acquis.
- **Simulation ≠ Stripe test ≠ activation live** : la simulation (transport simulé) ne
  remplace ni la catégorie B (Stripe test réel) ni la catégorie D (live).
- Aucun commit/merge/push sans ordre explicite.
- Aucune migration sur `icode_host_pro` (dev) ni sur une base client.
- Aucun paiement réel, aucun appel provider réel sans autorisation séparée.
- La simulation **n'équivaut ni à Stripe test ni à une validation d'infrastructure réelle**.
