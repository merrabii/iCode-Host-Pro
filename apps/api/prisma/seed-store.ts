/**
 * Seed STORE (Étape 2) — donne une vitrine publique testable.
 *
 * Idempotent : rattache à chaque produit existant (par nom) son slug, prix,
 * options configurables et add-ons. Les options/addons existants de CE produit
 * sont recréés (replace). Les données restent éditables depuis l'admin.
 *
 * Usage : pnpm db:seed:store   (dans apps/api)
 */
import {
  Prisma,
  PrismaClient,
  BillingCycle,
  ProductStatus,
  CheckoutFieldType,
  PaymentMethodType,
  FeeType,
  ProvisionAction,
} from '@prisma/client';

const prisma = new PrismaClient();

/** Taux de taxe par défaut (exonération) quand un produit n'en déclare aucun. */
const DEFAULT_TAXRATE = 'Exonéré 0%';

/** Champs de facturation par défaut (recréés si absents, idempotent). */
const DEFAULT_FIELDS: { key: string; label: string; type: CheckoutFieldType; required: boolean; placeholder?: string }[] = [
  { key: 'name', label: 'Nom complet', type: CheckoutFieldType.TEXT, required: true, placeholder: 'Ex : Sarah Benali' },
  { key: 'email', label: 'Adresse email', type: CheckoutFieldType.EMAIL, required: true, placeholder: 'vous@exemple.com' },
  { key: 'phone', label: 'Téléphone', type: CheckoutFieldType.TEL, required: true, placeholder: '+33 6 12 34 56 78' },
];

/** Définition de la vitrine par nom de produit. */
const STORE: Record<
  string,
  {
    slug: string;
    slogan?: string;
    shortDescription?: string;
    priceHtCents?: number;
    billingCycle?: BillingCycle;
    allowEditConfig?: boolean;
    installationFeeCents?: number;
    taxRateName?: string; // attache ce produit à un TaxRate (créé/actualisé)
    options?: { name: string; required: boolean; choices: { label: string; priceDeltaHtCents: number }[] }[];
    addons?: { name: string; description: string; priceHtCents: number }[];
    checkoutFields?: { key: string; label: string; type: CheckoutFieldType; required: boolean; placeholder?: string }[];
  }
> = {
  'Managed WP': {
    slug: 'managed-wp',
    slogan: 'WordPress géré, déployé en quelques clics sur votre infrastructure.',
    shortDescription: 'Un site WordPress géré avec SSL automatique, surveillance 24/7 et panneau de contrôle dédié.',
    priceHtCents: 2999, // 29,99 $ / mois
    billingCycle: BillingCycle.MONTHLY,
    taxRateName: 'TVA 20% (Standard)',
    installationFeeCents: 0, // Prix d'installation (0 par défaut) — modifiable en admin
    // Champs par défaut + un champ société optionnel, ex. de champ ajouté en admin.
    checkoutFields: [
      ...DEFAULT_FIELDS,
      { key: 'company', label: 'Société (optionnel)', type: CheckoutFieldType.TEXT, required: false, placeholder: 'Nom de la société' },
    ],
    options: [
      {
        name: 'Mémoire (RAM)',
        required: true,
        choices: [
          { label: '1 Go', priceDeltaHtCents: 0 },
          { label: '2 Go', priceDeltaHtCents: 400 },
          { label: '4 Go', priceDeltaHtCents: 1000 },
        ],
      },
      {
        name: 'Bande passante',
        required: false,
        choices: [
          { label: 'Standard (100 Go)', priceDeltaHtCents: 0 },
          { label: '+ 2 To', priceDeltaHtCents: 800 },
          { label: 'Illimitée', priceDeltaHtCents: 2000 },
        ],
      },
    ],
    addons: [
      { name: 'Sauvegarde quotidienne', description: 'Copie quotidienne conservée 30 jours.', priceHtCents: 500 },
      { name: 'IP dédiée', description: 'Adresse IPv4 dédiée pour votre site.', priceHtCents: 300 },
    ],
  },
  'Installation Fees': {
    slug: 'installation-fees',
    slogan: 'Frais d’installation unique de votre service.',
    shortDescription: 'Mise en place initiale de votre offre (configuration serveur & domaine).',
    priceHtCents: 9900, // 99,00 $ unique
    billingCycle: BillingCycle.ONETIME,
  },
};

async function main(): Promise<void> {
  let changed = 0;
  for (const [name, data] of Object.entries(STORE)) {
    const product = await prisma.product.findFirst({ where: { name } });
    if (!product) {
      console.warn(`  — produit "${name}" introuvable, ignoré.`);
      continue;
    }
    // Recrée la configuration vendable (replace) pour rester idempotent.
    await prisma.productOption.deleteMany({ where: { productId: product.id } });
    await prisma.productAddon.deleteMany({ where: { productId: product.id } });

    // Taux de taxe : rattacher un TaxRate nommé (créé si absent).
    let taxRateId: string | null = null;
    if (data.taxRateName) {
      let rate = await prisma.taxRate.findFirst({ where: { name: data.taxRateName } });
      if (!rate) {
        rate = await prisma.taxRate.create({
          data: { name: data.taxRateName, ratePercent: new Prisma.Decimal('20') },
        });
      }
      taxRateId = rate.id;
    }

    const upd: Parameters<typeof prisma.product.update>[0]['data'] = {
      slug: data.slug,
      status: ProductStatus.ACTIVE,
      slogan: data.slogan ?? null,
      shortDescription: data.shortDescription ?? null,
      priceHtCents: data.priceHtCents ?? null,
      billingCycle: data.billingCycle ?? BillingCycle.ONETIME,
      allowEditConfig: data.allowEditConfig ?? true,
      installationFeeCents: data.installationFeeCents ?? 0,
      taxRateId,
    };
    await prisma.product.update({ where: { id: product.id }, data: upd });

    // Champs de facturation (replace idempotent).
    await prisma.productCheckoutField.deleteMany({ where: { productId: product.id } });
    const fields = data.checkoutFields ?? DEFAULT_FIELDS;
    await prisma.productCheckoutField.createMany({
      data: fields.map((f, i) => ({ ...f, productId: product.id, sortOrder: i })),
    });

    if (data.options?.length) {
      for (const o of data.options) {
        await prisma.productOption.create({
          data: {
            productId: product.id,
            name: o.name,
            required: o.required,
            choices: { create: o.choices },
          },
        });
      }
    }
    if (data.addons?.length) {
      await prisma.productAddon.createMany({
        data: data.addons.map((a) => ({ ...a, productId: product.id })),
      });
    }
    changed++;
    console.log(`  ✔ "${name}" → /shop/${data.slug} (${(data.priceHtCents ?? 0) / 100} $, ${data.billingCycle})`);
  }
  console.log(`Seed store terminé : ${changed} produit(s) alimenté(s).`);

  await seedPaymentsAndBilling();
  await seedDefaultTaxRate();
  await seedDeployGithubProduct();
  await seedFreePlan();
}

/**
 * Bloc 6 — « Plan Gratuit » : produit à $0 + pack Starter minimal.
 *
 * Objectif (directive D) : un client peut commander le plan gratuit → le
 * checkout store (Bloc 1) crée un abonnement ACTIVE → l'espace client est réel
 * (quota affiché, déploiement petit). Le pack est VOLONTAIREMENT petit
 * (256 Mo / 0.5 CPU / 1 app) pour valider aussi la sécurité Bloc 3 (un build
 * lourd sous ce petit pack échoue l'APP seule, le serveur reste opérationnel).
 *
 * Idempotent : upsert par slug/name ; le pack « Starter » est créé s'il
 * n'existe pas (rattaché au module de déploiement par défaut actif).
 */
async function seedFreePlan(): Promise<void> {
  const FREE_SLUG = 'plan-gratuit';
  const FREE_NAME = 'Plan Gratuit';

  // 1. Pack « Starter » minimal (256 Mo / 0.5 CPU / 1 app), rattaché au module
  // de déploiement. On PRÉFÈRE le module par-client (kind PER_CLIENT_PROJECT) :
  // c'est la voie éprouvée en Bloc E — le projet partagé du module de type
  // SHARED_PROJECT peut être hors d'accès du token Coolify (réel : HTTP 403
  // "You are not allowed to access the API" sur le module A) et bloque CREATE_APP.
  const perClient =
    (await prisma.deploymentModule.findFirst({
      where: { isActive: true, kind: 'PER_CLIENT_PROJECT' },
    })) ??
    (await prisma.deploymentModule.findFirst({ where: { isActive: true } }));
  const module = perClient;
  let pack = await prisma.hostingPack.findFirst({ where: { name: 'Starter' } });
  if (!pack) {
    pack = await prisma.hostingPack.create({
      data: {
        name: 'Starter',
        description: 'Pack d’hébergement minimal du Plan Gratuit — pour valider l’upgrade sans perte (Bloc 6).',
        ramMb: 256,
        cpuCores: 0.5,
        maxApps: 1,
        status: 'ACTIVE',
        deploymentModuleId: module?.id ?? null,
      },
    });
    console.log(`  ✔ Pack « Starter » créé (256 Mo / 0.5 CPU / 1 app).`);
  } else {
    console.log(`  ✔ Pack « Starter » déjà présent (conservé).`);
  }

  // 2. Produit « Plan Gratuit » ($0, MONTHLY) relié au pack Starter.
  const existing = await prisma.product.findFirst({ where: { slug: FREE_SLUG } });
  const product = existing
    ? await prisma.product.update({
        where: { id: existing.id },
        data: {
          name: FREE_NAME,
          status: ProductStatus.ACTIVE,
          hidden: false,
          color: '#00b377',
          displayOrder: 0,
          packId: pack.id,
          priceHtCents: 0,
          billingCycle: BillingCycle.MONTHLY,
          installationFeeCents: 0,
          allowEditConfig: true,
          // Phase 16 — inscription autonome SANS checkout (décision B) : ce
          // flag débloque /auth/free-signup + le mode OAuth `free`.
          freePlan: true,
          slogan: 'Commencez gratuitement — un vrai espace client et un déploiement.',
          shortDescription:
            'Une souscription active (payée = 0) vous donne un espace client réel, un quota et un petit déploiement. Vous pouvez passer au plan supérieur à tout moment, sans perdre vos données.',
        },
      })
    : await prisma.product.create({
        data: {
          name: FREE_NAME,
          kind: 'generic',
          status: ProductStatus.ACTIVE,
          hidden: false,
          color: '#00b377',
          displayOrder: 0,
          slug: FREE_SLUG,
          packId: pack.id,
          priceHtCents: 0,
          billingCycle: BillingCycle.MONTHLY,
          installationFeeCents: 0,
          allowEditConfig: true,
          // Phase 16 — inscription autonome SANS checkout (décision B).
          freePlan: true,
          slogan: 'Commencez gratuitement — un vrai espace client et un déploiement.',
          shortDescription:
            'Une souscription active (payée = 0) vous donne un espace client réel, un quota et un petit déploiement. Vous pouvez passer au plan supérieur à tout moment, sans perdre vos données.',
        },
      });

  // Champs de facturation (replace idempotent) — détails de compte sur l'email.
  await prisma.productCheckoutField.deleteMany({ where: { productId: product.id } });
  await prisma.productCheckoutField.createMany({
    data: DEFAULT_FIELDS.map((f, i) => ({ ...f, productId: product.id, sortOrder: i })),
  });

  // 3. Câblage ProvisionMethod réel (occurrence "coolify-github") : le Plan
  // Gratuit déploie désormais une VRAIE app (site static par défaut) sur le
  // sous-domaine choisi par le client — pas un simple compte. Actions éprouvées
  // du Bloc E : CONFIGURE_DNS (sous-domaine demandé) → CREATE_APP → GENERATE_SSL.
  const method = await prisma.provisionMethod.upsert({
    where: { code: 'coolify-github' },
    update: {},
    create: {
      name: 'Coolify — Déploiement GitHub',
      code: 'coolify-github',
      description:
        'Attribue le sous-domaine gratuit (Cloudflare) D’ABORD, crée l’application depuis un dépôt GitHub public et y pose le domaine AVANT le premier déploiement, puis gère le SSL.',
      endpoint: '/applications/public',
      actions: [
        ProvisionAction.CONFIGURE_DNS,
        ProvisionAction.CREATE_APP,
        ProvisionAction.GENERATE_SSL,
      ],
      isActive: true,
    },
  });

  // Domaine racine Cloudflare (sous-domaine gratuit) + paramètres du dépôt static.
  const freeRoot = await prisma.domain.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });

  await prisma.product.update({
    where: { id: product.id },
    data: {
      provisionModuleId: method.id,
      moduleParams: {
        // App static par défaut de la première commande : guide de démarrage
        // Code Diali (Vite/React/Tailwind → vite build → dist). Remplaçable par
        // l'admin sur la fiche produit (« Application par défaut »).
        //
        // NB infra (vérifié live 2026-09-11) : le dépôt est un Vite/React app qui
        // DOIT être buildé → `build_pack` nixpacks (pas « static », qui sert le
        // repo brut → page blanche). Le repo porte un `.nvmrc` = 22 (nixpacks
        // choisit sinon node 18 → échec build, binding @tailwindcss/oxide). On
        // publie `dist/` statiquement via `publishDirectory` + `isStatic`.
        repoUrl: 'https://github.com/merrabii/Code-Diali-Guide-de-Demarrage.git',
        branch: 'main', // branche par défaut de `Code-Diali-Guide-de-Demarrage`
        buildPack: 'nixpacks', // build réel du repo → dist
        publishDirectory: '/dist', // publie la sortie `vite build` en statique
        isStatic: true,
        appName: 'plan-gratuit',
      } as Prisma.InputJsonObject,
    },
  });

  // Règle de sous-domaine gratuit (même domaine racine + contraintes que
  // « Deploy my GitHub App ») → le sélecteur de la page produit fonctionne.
  if (freeRoot) {
    await prisma.freeSubdomainRule.upsert({
      where: { productId: product.id },
      update: { allowedDomainIds: [freeRoot.id] },
      create: {
        productId: product.id,
        allowedDomainIds: [freeRoot.id],
        reservedPrefixes: ['www', 'mail', 'smtp', 'api', 'panel', 'admin', 'cdn', 'portal', 'host'],
        minLength: 3,
        maxLength: 40,
        allowedChars: 'a-z0-9-',
        rejectPattern: '(?i)^(www|mail|smtp|api|panel|admin|cdn|portal|host)$',
      },
    });
  }

  console.log(
    `  ✔ "Plan Gratuit" → /shop/plan-gratuit (0 $/mois) — pack=${pack.name}, method=${method.code}, root=${freeRoot?.name ?? '(aucun)'}.`,
  );
}

/**
 * Bloc E — produit test « Deploy my GitHub App » + ProvisionMethod réel.
 *
 * Crée/actualise le produit commandable, le câble à un ProvisionMethod
 * (actions CREATE_APP → CONFIGURE_DNS → GENERATE_SSL), au Module B existant
 * (serveur Coolify réel via le pack), à un projet racine Cloudflare pour le
 * sous-domaine gratuit, et pose `moduleParams` (dépôt public servi par Coolify).
 *
 * Idempotent : upsert par code de méthode et par nom de produit ; les relations
 * (`packId`, `provisionModuleId`, `taxRateId`, `freeSubdomainRule`) sont
 * re-synchronisées à chaque exécution.
 */
async function seedDeployGithubProduct(): Promise<void> {
  const GITHUB_PRODUCT = 'Deploy my GitHub App';

  // 1. ProvisionMethod « coolify-github » (upsert par code unique).
  const method = await prisma.provisionMethod.upsert({
    where: { code: 'coolify-github' },
    update: {
      name: 'Coolify — Déploiement GitHub',
      description:
        'Attribue le sous-domaine gratuit (Cloudflare) D’ABORD, crée l’application depuis un dépôt GitHub public et y pose le domaine AVANT le premier déploiement, puis gère le SSL.',
      endpoint: '/applications/public',
      actions: [
        ProvisionAction.CONFIGURE_DNS,
        ProvisionAction.CREATE_APP,
        ProvisionAction.GENERATE_SSL,
      ],
      isActive: true,
    },
    create: {
      name: 'Coolify — Déploiement GitHub',
      code: 'coolify-github',
      description:
        'Attribue le sous-domaine gratuit (Cloudflare) D’ABORD, crée l’application depuis un dépôt GitHub public et y pose le domaine AVANT le premier déploiement, puis gère le SSL.',
      endpoint: '/applications/public',
      actions: [
        ProvisionAction.CONFIGURE_DNS,
        ProvisionAction.CREATE_APP,
        ProvisionAction.GENERATE_SSL,
      ],
      isActive: true,
    },
  });

  // 2. Pack rattaché au Module B (projet par client sur le serveur Coolify réel).
  const moduleB = await prisma.deploymentModule.findFirst({
    where: { code: 'B' },
  });
  const pack = moduleB
    ? await prisma.hostingPack.findFirst({ where: { deploymentModuleId: moduleB.id } })
    : null;
  if (!pack) {
    console.warn('  — aucun pack rattaché au Module B, produit « Deploy my GitHub App » non câblé.');
    return;
  }

  // 3. Taxe TVA 20%.
  const tax = await prisma.taxRate.findFirst({ where: { name: 'TVA 20% (Standard)' } });
  if (!tax) {
    console.warn('  — TaxRate TVA 20% introuvable, produit non taxé.');
  }

  // 4. Domaine racine Cloudflare (sous-domaine gratuit).
  const rootDomain = await prisma.domain.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });

  // 5. Produit (upsert par nom — cohérent avec le reste du seed-store).
  const product = await prisma.product.upsert({
    where: { name: GITHUB_PRODUCT },
    update: {},
    create: { name: GITHUB_PRODUCT },
  });

  await prisma.product.update({
    where: { id: product.id },
    data: {
      slug: 'deploy-github-app',
      kind: 'generic',
      status: ProductStatus.ACTIVE,
      hidden: false,
      color: '#00b377',
      displayOrder: 10,
      slogan: 'Déployez votre application GitHub en un clic — sous-domaine gratuit inclus.',
      shortDescription:
        'Connectez un dépôt GitHub public : nous déployons votre app sur notre infrastructure et vous recevez un sous-domaine gratuit immédiatement accessible.',
      priceHtCents: 4900, // 49,00 $ / mois
      billingCycle: BillingCycle.MONTHLY,
      installationFeeCents: 0,
      allowEditConfig: true,
      taxRateId: tax ? tax.id : null,
      packId: pack.id,
      provisionModuleId: method.id,
      moduleParams: {
        repoUrl: 'https://github.com/octocat/Hello-World.git',
        branch: 'master', // octocat/Hello-World : branche par défaut = master (pas de main → build échoue)
        buildPack: 'static',
        appName: 'deploy-github-app',
      } as Prisma.InputJsonObject,
    },
  });

  // Champs de facturation (replace idempotent) — les détails de compte partent sur l'email.
  await prisma.productCheckoutField.deleteMany({ where: { productId: product.id } });
  await prisma.productCheckoutField.createMany({
    data: DEFAULT_FIELDS.map((f, i) => ({ ...f, productId: product.id, sortOrder: i })),
  });

  // 6. Règle de sous-domaine gratuit (allowedChars a-z0-9-, min 3, max 40).
  if (rootDomain) {
    await prisma.freeSubdomainRule.upsert({
      where: { productId: product.id },
      update: { allowedDomainIds: [rootDomain.id] },
      create: {
        productId: product.id,
        allowedDomainIds: [rootDomain.id],
        reservedPrefixes: ['www', 'mail', 'smtp', 'api', 'panel', 'admin', 'cdn', 'portal', 'host', 'diskpro', 'icodepro'],
        minLength: 3,
        maxLength: 40,
        allowedChars: 'a-z0-9-',
        rejectPattern: '(?i)^(www|mail|smtp|api|panel|admin|cdn|portal|host)$',
      },
    });
  }

  console.log(
    `  ✔ "${GITHUB_PRODUCT}" → /shop/deploy-github-app (49,00 $/mois) — method=${method.code}, pack=${pack.name}, root=${rootDomain?.name ?? '(aucun)'}`,
  );

  // 7. Options vendables (aucune requise — test tunnel automatisé simple).
}

/**
 * Seed paiement (Bloc C) — moyen de paiement globaux + paramètres de
 * facturation. Idempotent par `name` unique (upsert).
 * Virement + transfert actifs ; CARD présent mais inactif (« bientôt »).
 */
async function seedPaymentsAndBilling(): Promise<void> {
  // Paramètres de facturation (singleton, firstOrCreate).
  const billing = await prisma.billingSetting.findFirst();
  if (!billing) {
    await prisma.billingSetting.create({
      data: {
        currency: 'USD',
        companyName: 'Code Diali',
        companyEmail: 'support@codediali.com',
      },
    });
    console.log('  ✔ BillingSetting créé (USD, Code Diali).');
  } else {
    console.log('  ✔ BillingSetting déjà présent (conservé).');
  }

  // Moyens de paiement : virement + transfert actifs, carte réservée.
  const methods: {
    name: string;
    type: PaymentMethodType;
    isActive: boolean;
    displayOrder: number;
    config: Prisma.InputJsonValue;
  }[] = [
    {
      name: 'Virement bancaire',
      type: PaymentMethodType.BANK_TRANSFER,
      isActive: true,
      displayOrder: 1,
      config: {
        bankName: 'Code Diali Bank',
        beneficiary: 'Code Diali SAS',
        iban: 'FR76 3000 6000 0112 3456 7890 189',
        bic: 'CODI FR PP',
        referenceNote: 'Indiquez votre référence de commande dans le libellé du virement.',
      },
    },
    {
      name: 'Transfert direct',
      type: PaymentMethodType.MANUAL_TRANSFER,
      isActive: true,
      displayOrder: 2,
      config: {
        instructions:
          'Après paiement, vous recevrez vos détails de compte par email. Pour la preuve de virement, joignez une capture après paiement.',
      },
    },
    {
      name: 'Carte bancaire',
      type: PaymentMethodType.CARD,
      isActive: false, // réservé — affiché « bientôt »
      displayOrder: 3,
      config: { note: 'Paiement par carte disponible bientôt.' },
    },
  ];

  for (const m of methods) {
    await prisma.paymentMethod.upsert({
      where: { name: m.name },
      update: { isActive: m.isActive, displayOrder: m.displayOrder, config: m.config },
      create: { ...m },
    });
    console.log(`  ✔ PaymentMethod « ${m.name} » (${m.type}) active=${m.isActive}.`);
  }
}

/** Taux de taxe « Exonéré 0% » — référence des produits sans taxRate. */
async function seedDefaultTaxRate(): Promise<void> {
  const exists = await prisma.taxRate.findFirst({ where: { name: DEFAULT_TAXRATE } });
  if (!exists) {
    await prisma.taxRate.create({ data: { name: DEFAULT_TAXRATE, ratePercent: new Prisma.Decimal('0') } });
    console.log(`  ✔ TaxRate par défaut « ${DEFAULT_TAXRATE} » créé.`);
  } else {
    console.log(`  ✔ TaxRate par défaut « ${DEFAULT_TAXRATE} » déjà présent.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());