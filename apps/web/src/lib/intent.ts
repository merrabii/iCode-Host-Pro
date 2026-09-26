/**
 * 17B.4F-C2 — identité d'intention d'une soumission de déploiement (frontend).
 *
 * Contrat UI :
 *  - `intentFor(ref, payload)` renvoie le MÊME UUID v4 tant que le payload est
 *    identique → retry après timeout, double-clic et re-soumission accidentelle
 *    réutilisent la même intention (le serveur dédoublonne par empreinte) ;
 *  - un payload MODIFIÉ ⇒ nouvel UUID (nouvelle intention) ;
 *  - le ref est remis à zéro APRÈS un succès (page appelante) pour qu'une
 *    prochaine création — même formulaire — soit une opération neuve ;
 *  - un échec (dont 409 rejeu) conserve l'identité : aucun nouvel envoi auto.
 */

/** UUID v4 (crypto.randomUUID quand disponible, repli déterministe sinon). */
export function newIntentUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface IntentRef {
  current: { id: string; key: string } | null;
}

/** Id d'intention stable pour CE payload (nouveau si le payload change). */
export function intentFor(ref: IntentRef, payload: Record<string, unknown>): string {
  const key = JSON.stringify(payload);
  if (!ref.current || ref.current.key !== key) {
    ref.current = { id: newIntentUuid(), key };
  }
  return ref.current.id;
}
