/**
 * Construit un RegExp JS à partir d'une `rejectPattern` de FreeSubdomainRule.
 * Le pattern du seed est PCRE (`(?i)^(www|…)$`) : `(?i)` (insensibilité casse)
 * n'existe pas en JS. On isole ce bloc de flags en tête et on l'applique au
 * flag `i`, le reste étant le corps du pattern.
 */
export function regexFromRejectPattern(rejectPattern?: string | null): RegExp | null {
  if (!rejectPattern) return null;
  const head = rejectPattern.match(/^\(\?([a-zA-Z-]+)\)/);
  if (!head) return new RegExp(rejectPattern);
  const flags = head[1].replace(/-/g, ''); // `(?i)` → `i` ; `(?i-s)` → `i` ; unsupported → `u`/`s` gérés par V8
  const body = rejectPattern.slice(head[0].length);
  return new RegExp(body, flags);
}