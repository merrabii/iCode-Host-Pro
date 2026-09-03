# Trafic, quotas & suspension — analyse (2026-09-03)

Analyse de l'existant réel, écarts et recommandation → **ADR-029 (PROPOSED)**.
Cadre : distinguer **mesure** (constater) / **quota** (plafond métier) /
**limitation** (rate limit technique) / **suspension** (action d'exploitation).

## 1. Ce qui existe réellement (vérifié sur le code)

### 1.1 Limitation (rate limiting) — `apps/api/src/auth/rate-limiter.ts`
Rate limiter maison : fenêtre glissante **en mémoire**, clé = IP + route,
zéro dépendance, 429. Presets :

| Endpoint | Limite | Fenêtre |
|---|---|---|
| `POST /auth/login` | 10 | 60 s |
| `POST /auth/mfa/verify` | 5 | 60 s |
| `POST /auth/mfa/email/send` | 5 | 60 s |
| `POST /auth/register` | 5 | 60 s |
| `POST /checkout/intent` | 20 | 60 s |
| `POST /support/access` | 10 | 60 s |

**Limites de l'existant** :
- Mémoire seule, par instance → un restart réinitialise tout (acceptable en
  instance unique — documenté comme tel, pas une faille).
- Non distribué : un déploiement multi-réplicas ne partage pas les buckets
  (→ 10 × le budget par IP).
- Aucune mesure de trafic persistée, aucun compteur par utilisateur.

### 1.2 Mesure (journalisation)
- Le **journal d'audit** (`AuditLog`, Phase 4) enregistre les mutations et
  certaines lectures sensibles, mais **pas le trafic** (ni volume, ni bande
  passante, ni hits par route).
- Aucun agrégat de trafic, aucun compteur, aucune alerte.

### 1.3 Quota (plafond métier)
- Le champ **`Server.quota`** (Phase 7ter / ADR-024) existe et est affiché dans
  l'admin, mais **n'est pas appliqué** : aucune vérification de consommation
  côté souscriptions/services. C'est une métadonnée d'intention.
- Aucun quota par utilisateur (nb de services, nb de tickets actifs, volume).

### 1.4 Suspension
- **`User.isActive`** (Phase 3 / ADR-018) : suspension/désactivation **manuelle**
  par l'admin, avec gardes anti-verrouillage (impossible de désactiver le
  dernier ADMIN actif). Auditée (`user.deactivate` / `user.activate`).
- Aucune suspension **automatique** (ni par échec, ni par dépassement, ni par
  impayé — pas de facturation).

### 1.5 Absences structurantes
- Pas de jobs asynchrones (ADR-007 **PROPOSED**), pas de Redis (ADR-006
  **PROPOSED**, ADR-012 = Postgres seul).
- Pas de mesures réseau réelles automatisées : la sonde (ADR-025) est **à la
  demande** (bouton « Re-tester »), pas périodique.
- Métriques serveur (RAM/CPU/disque/bande passante, Phase 9bis) : collectées à
  la demande depuis les panneaux, non historisées.

## 2. Recommandation — architecture en 4 couches (ADR-029)

La recommandation est de **documenter la séparation** et de n'implémenter que ce
qui est justifié par un besoin réel (le projet est en pré-lancement, mono-instance) :

1. **Mesure (fondation)** — à faire en premier si besoin réel :
   - Compter les appels par route + IP (table agrégée ou compteurs en mémoire
     périodiquement persistés) ; volume par utilisateur/service.
   - Nécessite un job périodique (ADR-007) ou un comptage inline léger.
2. **Quota (métier)** — plafonds par utilisateur **appliqués** (ex. max
   N services actifs, M tickets ouverts, X Go) avec blocage explicite (429/403
   dédié) et messages français. Aujourd'hui seul le `Server.quota` existe et il
   n'est pas appliqué — le décider explicitement.
3. **Limitation (technique)** — l'existant suffit en mono-instance. Passer à un
   store partagé (Redis / table) **uniquement** si multi-réplicas.
4. **Suspension (exploitation)** — reste **manuelle** (isActive) tant qu'il n'y a
   ni facturation ni abus constaté. L'automatisation (dépassement de quota →
   suspension) ne viendra qu'avec les quotas appliqués et devra être auditée.

**Périmètre explicite NON retenu maintenant** : pas de paiement, pas de
facturation, pas de quotas appliqués, pas de jobs périodiques, pas de Redis.
→ voir ADR-029 dans `DECISIONS.md` (PROPOSED, à valider par le propriétaire).
