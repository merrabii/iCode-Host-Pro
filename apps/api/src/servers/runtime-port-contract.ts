/**
 * Contrat build-pack / runtime → port exposé par défaut.
 *
 * Ce module est le SOURCE DE SECONDE ligne du port « effectivement exposé » d'un
 * backend Servé (non statique), utilisé **uniquement** lorsque le provider ne peut
 * pas le déterminer lui-même (`resolveExposedPort()` → null — cas réel de Coolify
 * 4.1.2 : `ports_exposes` reste null tant que l'image n'a pas été analysée).
 *
 * RÔLE — ce n'est PAS un « port canonique » global ni une constante de provisioning
 * (`const NODE_PORT = 8080` serait interdit). C'est une **connaissance explicite du
 * build pack / runtime**, représentée comme donnée de configuration, du même esprit
 * qu'un manifeste d'image (Docker EXPOSE). Elle est :
 *  • indépendante du dépôt / slug / URL / framework / application ;
 *  • générique et extensible (Node/Nixpacks aujourd'hui → Python/PHP/Go/… demain) ;
 *  • jamais inventée silencieusement : si aucun contrat ne matche, on retourne `null`
 *    et le moteur refuse de deviner un port (-> diagnostic, jamais ACTIVE).
 *
 * Evidence réelle (2026-09-15, Coolify 4.1.2, app Node nixpacks heroku/public) :
 *  l'image produite EXPOSE 8080 (seul port joignable par Traefik, vérifié : un
 *  `ports_exposes=3000` + process écoutant 3000 + restart => 502 persistant), alors
 *  que `GET /applications/{uuid}.ports_exposes` renvoie `null` à la création ET après
 *  un build `finished`. Le contrat représente donc ce port exposé réel.
 */

export interface RuntimePortContract {
  /** Nom du build pack (ex. `nixpacks`). Clé de résolution. */
  buildPack: string;
  /** Runtime mis en évidence (best-effort, optionnel). */
  runtime?: string;
  /** Port exposé par défaut RÉELLEMENT routable par l'image de ce build pack. */
  defaultExposedPort: number | null;
  /** Source de vérité de cette valeur. */
  source: 'buildpack-contract';
}

/**
 * Registre des contrats build-pack → port exposé par défaut.
 * ⚠️ Rajouter une entrée = déclarer une connaissance CONFIRMÉE du port routable de
 * l'image pour ce build pack/runtime, jamais une supposition liée à un dépôt.
 */
const BUILD_PACK_PORT_CONTRACTS: RuntimePortContract[] = [
  {
    buildPack: 'nixpacks',
    runtime: 'node',
    // Nixpacks/Node : l'image expose 8080 sur cette plateforme (voir evidence ci-haut).
    defaultExposedPort: 8080,
    source: 'buildpack-contract',
  },
  // Extensible : Python/PHP/Go/Ruby/Java — à ajouter quand confirmés (jamais de
  // faux routage : l'ajout doit refléter l'EXPOSE réellement produit).
];

/**
 * Résout le contrat de port exposé pour un build pack donné.
 * Retourne `null` si aucun contrat n'existe — le moteur NE doit PAS deviner un port.
 */
export function resolveBuildPackPortContract(
  buildPack: string | null | undefined,
): RuntimePortContract | null {
  if (!buildPack) return null;
  const key = String(buildPack).trim().toLowerCase();
  const found = BUILD_PACK_PORT_CONTRACTS.find((c) => c.buildPack.toLowerCase() === key);
  return found ?? null;
}