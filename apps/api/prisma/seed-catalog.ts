// Réparation + catalogue + auto-vérification de la CHAÎNE de liaison store.
//
// Chaîne cible (règle owner) : PRODUCT → (categoryId) → CATEGORY
//   → (recommendedPackId) → PACK → (deploymentModuleId) → MODULE (B) → SERVER.
// Provisioning lit EXACTEMENT `order.product.pack.deploymentModule.server` :
// si un maillon manque (pack.deploymentModuleId NULL, produit sans moduleParams,
// serveur sans jeton), l'app n'est JAMAIS créée sur Coolify.
//
// IDEMPOTENT — ne SUPPRIME JAMAIS de donnée : upsert par clés métier uniques
// (module.code, pack.name, category.name, product.slug/name, method.code).
//
// À la fin : SELF-CHECK — pour chaque produit ACTIVE non-hidden, on résout la
// chaîne complète et on affirme qu'elle aboutit à un serveur COOLIFY avec
// apiBaseUrl + jeton. Exit != 0 si un produit est cassé (la « liaison correcte »
// est alors à corriger). Aucune suppression n'est jamais effectuée.
import 'dotenv/config';
import { PrismaClient, ProductStatus, BillingCycle } from '@prisma/client';

const prisma = new PrismaClient();

/** Repo public réel et éprouvé (déployé en validation réelle) — la même ressource
 *  peut alimenter plusieurs produits : chaque produit/commande reçoit SON sous-domaine
 *  et SA propre app Coolify. */
const DEFAULT_REPO = 'https://github.com/merrabii/Code-Diali-Guide-de-Demarrage.git';

async function moduleByCode(code: string) {
  return prisma.deploymentModule.findFirst({ where: { code } });
}
async function methodByCode(code: string) {
  return prisma.provisionMethod.findUnique({ where: { code } });
}
async function taxByName(name: string) {
  return prisma.taxRate.findFirst({ where: { name } });
}

/** Assure qu'un pack pointe bien sur le module (chaîne PACK→MODULE). */
async function linkPackToModule(packName: string, moduleId: string) {
  const pack = await prisma.hostingPack.upsert({
    where: { name: packName },
    update: { deploymentModuleId: moduleId },
    create: {
      name: packName,
      description: `Pack « ${packName} » relié au module de déploiement.`,
      ramMb: 512,
      cpuCores: 1,
      maxApps: 2,
      status: 'ACTIVE',
      deploymentModuleId: moduleId,
    },
  });
  console.log(`  pack "${packName}" → module ${moduleId.slice(-6)}`);
  return pack;
}

/** Assure qu'un produit est lié à sa catégorie, son pack, sa méthode et porte les
 *  moduleParams nécessaires à la création d'app Coolify. */
async function upsertProduct(params: {
  name: string;
  slug: string;
  kind: string;
  categoryName: string;
  packName: string;
  methodCode: string;
  priceCents: number;
  billingCycle: BillingCycle;
  slogan?: string;
  shortDescription?: string;
  isStatic?: boolean;
  repoUrl?: string;
  branch?: string;
  appName?: string;
}) {
  const category = await prisma.productCategory.upsert({
    where: { name: params.categoryName },
    update: { recommendedPackId: undefined }, // laissé tel quel si déjà posé
    create: { name: params.categoryName },
  });
  // Lien CATEGORY→PACK : le pack recommandé de la catégorie.
  const recommended = await prisma.hostingPack.findFirst({ where: { name: params.packName } });
  if (recommended) {
    await prisma.productCategory.update({ where: { id: category.id }, data: { recommendedPackId: recommended.id } });
    console.log(`  catégorie "${params.categoryName}" → pack recommandé "${params.packName}"`);
  }
  const pack = await prisma.hostingPack.findFirst({ where: { name: params.packName } });
  const method = await methodByCode(params.methodCode);
  if (!pack) throw new Error(`Pack introuvable : ${params.packName}`);
  if (!method) throw new Error(`Méthode introuvable : ${params.methodCode}`);

  const moduleParams =
    params.repoUrl === null
      ? {}
      : {
          repoUrl: params.repoUrl ?? DEFAULT_REPO,
          branch: params.branch ?? 'main',
          appName: params.appName ?? params.slug,
          buildPack: params.isStatic ? 'nixpacks' : 'nixpacks',
          publishDirectory: params.isStatic ? '/dist' : undefined,
          isStatic: params.isStatic ?? false,
        };

  const data = {
    name: params.name,
    slug: params.slug,
    kind: params.kind,
    status: ProductStatus.ACTIVE,
    hidden: false,
    categoryId: category.id,
    packId: pack.id,
    provisionModuleId: method.id,
    priceHtCents: params.priceCents,
    billingCycle: params.billingCycle,
    slogan: params.slogan,
    shortDescription: params.shortDescription,
    moduleParams,
  };
  // Match par slug PUIS par name (robuste : un produit existant peut avoir un
  // slug NULL — comme « GitHub App Deploy » re-créé à la main). Aucune suppression.
  const existing =
    (await prisma.product.findUnique({ where: { slug: params.slug } })) ??
    (await prisma.product.findFirst({ where: { name: params.name } }));
  const product = existing
    ? await prisma.product.update({ where: { id: existing.id }, data })
    : await prisma.product.create({ data });
  console.log(`  produit "${params.name}" → catégorie "${params.categoryName}" + pack "${params.packName}" + method "${params.methodCode}"`);
  return product;
}

async function main(): Promise<number> {
  // 1. Module cible (B). NE PAS en créer — l'owner l'a déjà configuré.
  const moduleB = await moduleByCode('B');
  if (!moduleB) {
    console.error('✗ Module B introuvable — créer le module B (PER_CLIENT_PROJECT) avant de lancer ce seed.');
    return 1;
  }
  const server = await prisma.server.findUnique({ where: { id: moduleB.serverId ?? '' } }).catch(() => null);
  if (!server) {
    console.error(`✗ Le module B n'a pas de serveur rattaché (serverId=${moduleB.serverId}).`);
    return 1;
  }

  console.log(`Module B : ${moduleB.name} (${moduleB.kind}) — serveur ${server.name} (${server.panelProvider})`);
  const method = await methodByCode('coolify-github');
  if (!method) {
    console.error('✗ Méthode "coolify-github" introuvable — lancer db:seed:store d’abord.');
    return 1;
  }

  // 2. RÉPARATION : pousse les packs existants/nouveaux vers le module B.
  await linkPackToModule('Starter', moduleB.id);
  await linkPackToModule('Go App', moduleB.id);
  await linkPackToModule('Node API', moduleB.id);
  await linkPackToModule('Static', moduleB.id);

  // 3. Catalogue produits — chaque produit chaîné vers le module B via son pack.
  await upsertProduct({
    name: 'GitHub App Deploy',
    slug: 'deploy-github-app',
    kind: 'Hosting',
    categoryName: '1 Click Host GitHub App',
    packName: 'Go App',
    methodCode: 'coolify-github',
    priceCents: 4900,
    billingCycle: BillingCycle.MONTHLY,
    slogan: 'Déployez votre application GitHub en un clic — sous-domaine gratuit inclus.',
    shortDescription: 'Un dépôt GitHub public est déployé sur notre infrastructure avec un sous-domaine gratuit immédiatement accessible.',
    isStatic: true,
    appName: 'github-app-deploy',
  });
  await upsertProduct({
    name: 'API Node.js Starter',
    slug: 'api-node-starter',
    kind: 'Hosting',
    categoryName: '1 Click Host GitHub App',
    packName: 'Node API',
    methodCode: 'coolify-github',
    priceCents: 2500,
    billingCycle: BillingCycle.MONTHLY,
    slogan: 'Une API Node.js déployée et servie en HTTPS.',
    shortDescription: 'Backend Node.js/Express déployé sur notre infrastructure, sous-domaine gratuit inclus.',
    // Produit BACKEND Node (isStatic:false, pas de publishDirectory) → repo de
    // validation Express réel. La logique générique (résolution de port ADR-038)
    // s'applique ; cette URL est UNIQUEMENT la config produit (jamais codée dans
    // le moteur de provisioning).
    repoUrl: 'https://github.com/heroku/nodejs-getting-started.git',
    isStatic: false,
    appName: 'api-node-starter',
  });
  await upsertProduct({
    name: 'Site Statique Premium',
    slug: 'site-statique-premium',
    kind: 'Hosting',
    categoryName: 'Sites Web Statiques',
    packName: 'Static',
    methodCode: 'coolify-github',
    priceCents: 1500,
    billingCycle: BillingCycle.MONTHLY,
    slogan: 'Un site statique rapide, servi en HTTPS.',
    shortDescription: 'SPA Vite/Next construite puis servie en statique, sous-domaine gratuit inclus.',
    isStatic: true,
    appName: 'site-statique-premium',
  });

  // 3b. Plan Gratuit : le rattacher à une catégorie dédiée (chaîne catégorie→pack
  //     complète) pour qu'il apparaisse dans /shop et satisfasse la règle owner.
  const starter = await prisma.hostingPack.findFirst({ where: { name: 'Starter' } });
  if (starter) {
    const freeCat = await prisma.productCategory.upsert({
      where: { name: 'Plan Gratuit' },
      update: { recommendedPackId: starter.id, displayOrder: 99 },
      create: { name: 'Plan Gratuit', recommendedPackId: starter.id, displayOrder: 99 },
    });
    await prisma.product.updateMany({
      where: { slug: 'plan-gratuit' },
      data: { categoryId: freeCat.id },
    });
    console.log(`  produit "Plan Gratuit" → catégorie "${freeCat.name}" + pack recommandé "Starter"`);
  }

  // 4. SELF-CHECK : résout la chaîne complète de chaque produit ACTIVE visible.
  //    Le provisioning lit EXACTEMENT `product.pack.deploymentModule.server` ;
  //    la chaîne catégorie→pack (recommendedPack) sert de gestion/vitrine.
  console.log('\n─── AUTO-VÉRIFICATION DE LA LIAISON (Product→Pack→Module→Server) ───');
  const products = await prisma.product.findMany({
    where: { status: ProductStatus.ACTIVE, hidden: false },
    include: {
      pack: { include: { deploymentModule: { include: { server: true } } } },
      category: { include: { recommendedPack: true } },
    },
  });
  let failures = 0;
  for (const p of products) {
    const srv = p.pack?.deploymentModule?.server ?? null;
    const hasParams = !!((p.moduleParams as { repoUrl?: string } | null)?.repoUrl);
    const ok =
      !!srv &&
      srv.panelProvider === 'COOLIFY' &&
      !!srv.apiBaseUrl &&
      !!srv.apiTokenEnc &&
      !!p.pack?.deploymentModule &&
      hasParams;
    const categoryLinkOk = !!p.category?.recommendedPack;
    const chain = ok
      ? `${p.pack?.deploymentModule?.kind ?? '?'} → ${srv.name} (${srv.apiBaseUrl})`
      : (!p.pack?.deploymentModule ? 'PACK SANS MODULE ✗' : !srv ? 'MODULE SANS SERVEUR ✗' : !hasParams ? 'PRODUIT SANS moduleParams ✗' : 'SERVEUR INCOMPLET ✗');
    console.log(`  ${ok ? '✔' : '✗'} "${p.name}" → pack="${p.pack?.name}" → ${chain}${categoryLinkOk ? '' : '  | catégorie SANS pack recommandé ✗'}`);
    if (!ok) failures++;
    if (!categoryLinkOk) failures++;
  }
  if (failures === 0) console.log('\n✔ CHAÎNE VALIDE pour tous les produits ACTIVE.');
  else console.error(`\n✗ ${failures} produit(s) cassé(s) — corriger avant de déclarer opérationnel.`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => prisma.$disconnect().then(() => {
    process.exitCode = code;
  }))
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });