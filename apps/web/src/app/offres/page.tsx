import { redirect } from 'next/navigation';

/**
 * Ancien catalogue public `/offres` (sans prix, doublon de `/shop`) →
 * redirection vers `/shop` (décision B6-a).
 *
 * La route est CONSERVÉE : les anciens liens publics continuent de fonctionner.
 * La query string est intégralement reportée sur `/shop` (les paramètres encore
 * utiles au parcours sont préservés ; les inconnus sont ignorés sans casse).
 */
export default async function OffresPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp ?? {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v);
    } else {
      qs.append(key, value);
    }
  }
  const query = qs.toString();
  redirect(query ? `/shop?${query}` : '/shop');
}
