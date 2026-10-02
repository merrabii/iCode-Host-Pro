'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  addTicketMessage,
  apiError,
  BUILD_PACKS,
  cancelMySubscription,
  clearImpToken,
  createDeployment,
  detectDeployment,
  createTicket,
  decodeJwt,
  deleteMyDeployment,
  fetchMe,
  generateSupportCode,
  getMyDeployment,
  getPublicAuthConfig,
  getSessionToken,
  getSupportCodeStatus,
  githubLinkStatus,
  listGithubRepos,
  listHostingServices,
  listMyDeployments,
  listMySubscriptions,
  listMyTickets,
  listPublicProducts,
  returnFromImpersonation,
  revokeSupportCode,
  type BuildPack,
  type ClientDeployQuota,
  type Deployment,
  type DetectResult,
  type GithubLinkStatus,
  type GithubRepo,
  type HostingServiceOption,
  type Me,
  type ProductRef,
  type PublicProduct,
  type Subscription,
  type Ticket,
} from '@/lib/api';
import { intentFor } from '@/lib/intent';
import { AppShell, ImpersonationBanner, type NavSection } from '@/components/app-shell';
import { CLIENT_NAV } from '@/config/nav';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  PageLoading,
  Panel,
  Select,
  statusTone,
} from '@/components/ui';
import { IconKey, IconPlus, IconRefresh, IconServer, IconX } from '@/components/icons';

type Phase = 'loading' | 'denied' | 'ready';

/** Rubriques de l'espace client — source de vérité = l'URL (`?rub=`), les
 *  entrées de sidebar sont des liens directs (fonctionnent depuis /profil et /aide). */
type Rub = 'apps' | 'host' | 'help';
  /** En-tête de page par rubrique (h2 du bloc client-head). */
  const RUB_TITRE: Record<Rub, string> = {
    apps: 'Mes applications',
    host: 'Hébergement & abonnements',
    help: 'Assistance',
  };
  /** Libellés courts (onglets + titre du document). */
  const RUB_LABEL: Record<Rub, string> = {
    apps: 'Applications',
    host: 'Hébergement',
    help: 'Assistance',
  };

interface Product {
  id: string;
  name: string;
  kind: string;
  status: string;
  slug?: string | null;
  pack?: ProductRef['pack'] | null;
}

const SUB_STATUS_LABEL: Record<string, string> = {
  PENDING: 'En attente',
  ACTIVE: 'Active',
  REJECTED: 'Rejetée',
  SUSPENDED: 'Suspendue',
  CANCELLED: 'Annulée',
};
// Bloc 4 : la table Service a été supprimée — plus de flux « service demandé ».
const TICKET_STATUS_LABEL: Record<string, string> = {
  OPEN: 'Ouvert',
  IN_PROGRESS: 'En cours',
  WAITING_CLIENT: 'En attente client',
  RESOLVED: 'Résolu',
  CLOSED: 'Fermé',
};
const DEP_STATUS_LABEL: Record<string, string> = {
  PENDING: 'En file',
  DEPLOYING: 'Déploiement en cours',
  ACTIVE: 'Déployé',
  FAILED: 'Échec',
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n <= 1 ? one : many}`;
}

/** Barre de progression quota/ressource (classes Phase 13 dans globals.css). */
function UsageBar({
  label,
  used,
  limit,
  unit = '',
}: {
  label: string;
  used: number;
  limit: number | null;
  unit?: string;
}) {
  if (limit == null || limit <= 0) {
    return (
      <div className="bar-wrap">
        <div className="bar-meta">
          <span className="bar-label">{label}</span>
          <span className="muted">Illimité</span>
        </div>
        <div className="bar-track">
          <div className="bar-fill neutral" style={{ width: '100%' }} />
        </div>
      </div>
    );
  }
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const over = used > limit;
  return (
    <div className="bar-wrap">
      <div className="bar-meta">
        <span className="bar-label">{label}</span>
        <span className={over ? 'danger-text' : 'muted'}>
          {used} / {limit} {unit}
          {over && <Badge tone="danger">DÉPASSÉ</Badge>}
        </span>
      </div>
      <div className="bar-track">
        <div className={`bar-fill ${over ? 'danger' : 'ok'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Entrée de route : la rubrique active vient de l'URL (`?rub=`) — les liens de
 *  la sidebar naviguent SANS remonter la page (données et brouillon conservés). */
export default function ClientPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ClientSpace />
    </Suspense>
  );
}

function ClientSpace() {
  const router = useRouter();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState('');
  const [isImp, setIsImp] = useState(false);
  const [impKind, setImpKind] = useState<'admin' | 'support'>('admin');
  const [impBy, setImpBy] = useState('');

  const [products, setProducts] = useState<Product[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);

  // Support code (accès support).
  const [codeActive, setCodeActive] = useState(false);
  const [codeExpiry, setCodeExpiry] = useState<string | null>(null);
  const [shownCode, setShownCode] = useState<string | null>(null);

  // Mes tickets.
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [ticketReply, setTicketReply] = useState<Record<string, string>>({});
  const [tSubject, setTSubject] = useState('');
  const [tBody, setTBody] = useState('');

  // Déploiements GitHub → Coolify (Phase 10bis) — panneau masqué si désactivé.
  const [deployEnabled, setDeployEnabled] = useState(false);
  const [github, setGithub] = useState<GithubLinkStatus | null>(null);
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [depRepo, setDepRepo] = useState('');
  const [depBranch, setDepBranch] = useState('');
  // Mode URL collée (Phase 10bis.5) — détection auto, champs éditables.
  const [depTab, setDepTab] = useState<'github' | 'url'>('github');
  const [depUrl, setDepUrl] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [depAppName, setDepAppName] = useState('');
  const [depBuildPack, setDepBuildPack] = useState<BuildPack>('nixpacks');
  // Phase 3 — sous-domaine gratuit (optionnel) ; vide = slug auto.
  const [depSubdomain, setDepSubdomain] = useState('');
  // Quota d'apps du pack ACTIF (Phase 13).
  const [quota, setQuota] = useState<ClientDeployQuota | null>(null);
  // Suppression d'une app (confirmation en deux temps) + mise à niveau du plan.
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Création d'application : MODALE « Nouvelle application » (fermée par
  // défaut). États du formulaire (saisies, source, depIntent) vivent dans ce
  // composant parent → brouillon conservé à la fermeture/réouverture.
  const [formOpen, setFormOpen] = useState(false);
  /** Élément déclencheur (CTA permanent d'en-tête) : focus rendu à la fermeture. */
  const formOpener = useRef<HTMLElement | null>(null);
  // Rubriques : source de vérité = l'URL `?rub=` (liens sidebar directs,
  // fonctionnent depuis /profil et /aide ; pas de remount → données et
  // brouillon conservés au changement de rubrique).
  const searchParams = useSearchParams();
  const rubParam = searchParams.get('rub');
  const rub: Rub = rubParam === 'host' ? 'host' : rubParam === 'help' ? 'help' : 'apps';
  const goRub = (r: Rub) => {
    if (r !== rub) router.push(`/client?rub=${r}`);
  };
  // Menu « … » d'une ligne d'application (suppression = action à 2 temps,
  // via deleteApp existant — aucun nouveau service).
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // 17B.4F-C2 — sélecteur de service hébergement (inerte si garde OFF),
  // garde anti-double-clic et identité d'intention du déploiement.
  const [hsOptions, setHsOptions] = useState<HostingServiceOption[]>([]);
  const [hsChoice, setHsChoice] = useState('');
  const [depBusy, setDepBusy] = useState(false);
  const depIntent = useRef<{ id: string; key: string } | null>(null);

  const load = useCallback(
    async (t: string) => {
      try {
        const [p, s] = await Promise.all([listPublicProducts(), listMySubscriptions(t)]);
        setProducts((p.data as Product[]) ?? []);
        setSubs((s.data as Subscription[]) ?? []);
      } catch {
        toast.error('Impossible de charger l’espace client.');
      }
    },
    [toast],
  );

  const loadCodeStatus = useCallback(
    async (t: string) => {
      const r = await getSupportCodeStatus(t);
      if (r.ok) {
        const d = r.data as { active: boolean; expiresAt?: string | null };
        setCodeActive(!!d.active);
        setCodeExpiry(d.expiresAt ?? null);
      }
    },
    [],
  );

  const loadTickets = useCallback(async (t: string) => {
    const r = await listMyTickets(t);
    if (r.ok) setTickets((r.data as Ticket[]) ?? []);
  }, []);

  // GitHub (Phase 10bis) : état de la liaison + repos autodétectés.
  const loadGithub = useCallback(async (t: string) => {
    const [ls, r] = await Promise.all([githubLinkStatus(t), listGithubRepos(t)]);
    if (ls.ok) setGithub((ls.data as GithubLinkStatus) ?? null);
    if (r.ok) setRepos((r.data as GithubRepo[]) ?? []);
  }, []);

  // 17B.4F-C2 — services hébergement sélectionnables. Garde OFF ⇒ réponse
  // inerte { enabled:false, services:[] } (aucun champ n'apparaît alors).
  const loadHostingServices = useCallback(async (t: string) => {
    const r = await listHostingServices(t);
    if (r.ok) setHsOptions(r.data?.services ?? []);
  }, []);

  // Déploiements + rafraîchissement live des statuts en cours + quota du pack (Phase 13).
  const loadDeployments = useCallback(async (t: string) => {
    const r = await listMyDeployments(t);
    if (!r.ok) return;
    const payload = r.data as { deployments: Deployment[]; quota: ClientDeployQuota | null } | Deployment[] | null;
    // Ancien format (fallback) : tableau direct. Nouveau (Phase 13) : { deployments, quota }.
    let list = Array.isArray(payload) ? payload : (payload?.deployments ?? []);
    if (payload && !Array.isArray(payload)) {
      setQuota(payload.quota);
    }
    const live = await Promise.all(
      list.filter((d) => d.status === 'DEPLOYING').map((d) => getMyDeployment(t, d.id)),
    );
    const byId = new Map<string, Deployment>();
    for (const item of live) {
      const d = item.data as Deployment | null;
      if (item.ok && d) byId.set(d.id, d);
    }
    list = list.map((d) => byId.get(d.id) ?? d);
    setDeployments(list);
  }, []);

  useEffect(() => {
    (async () => {
      const t = await getSessionToken();
      if (!t) {
        router.replace('/auth');
        return;
      }
      const m = await fetchMe(t);
      if (!m) {
        setPhase('denied');
        return;
      }
      const dec = decodeJwt(t);
      setToken(t);
      setMe(m);
      setIsImp(!!dec?.imp);
      setImpKind(dec?.imp?.kind ?? 'admin');
      setImpBy(dec?.imp?.by ?? '');
      setPhase('ready');
      void load(t);
      void loadCodeStatus(t);
      void loadTickets(t);
      const cfg = await getPublicAuthConfig();
      if (cfg?.deployEnabled) {
        setDeployEnabled(true);
        void loadGithub(t);
        void loadDeployments(t);
        void loadHostingServices(t);
      }
    })();
  }, [router, load, loadCodeStatus, loadTickets, loadGithub, loadDeployments, loadHostingServices]);

  // Auto-poll : tant qu'un déploiement est en cours, re-sonde toutes les 8 s.
  useEffect(() => {
    if (!deployEnabled || !token) return;
    const hasDeploying = deployments.some((d) => d.status === 'DEPLOYING');
    if (!hasDeploying) return;
    const id = setInterval(() => void loadDeployments(token), 8000);
    return () => clearInterval(id);
  }, [deployEnabled, token, deployments, loadDeployments]);

  // Titre du document = rubrique active (stamp unique au changement de
  // rubrique — pas d'observateur ; Next gère ses métadonnées normalement).
  useEffect(() => {
    document.title = `${RUB_LABEL[rub]} · Espace client`;
  }, [rub]);

  // Menu « … » : fermeture au clic extérieur (le bouton a stopPropagation)
  // et à Échap (le focus revient sur le bouton de la ligne).
  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuFor(null);
        document.getElementById(`client-menu-btn-${menuFor}`)?.focus();
      }
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  // CTA unique « Nouvelle application » (permanent, en tête de rubrique sur
  // TOUS les formats — plus de FAB mobile) : ouvre la MODALE dans la rubrique
  // Applications (et la referme si déjà ouverte).
  function openForm() {
    formOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFormOpen(true);
  }
  function closeForm() {
    // Le focus est rendu au déclencheur par le cleanup de l'effet
    // d'ouverture (après retrait de inert) : le CTA d'en-tête étant
    // permanent (jamais démonté), le focus lui revient en haut de page.
    setFormOpen(false);
  }
  function onNewAppClick() {
    goRub('apps');
    if (formOpen) closeForm();
    else openForm();
  }

  // Modale : Échap ferme + piège de focus (Tab reste dans la dialog, le focus
  // entre dans la dialog même depuis le CTA hors-scrim).
  useEffect(() => {
    if (!formOpen) return;
    const focusables = () => {
      const d = document.querySelector('[data-client-form]');
      if (!(d instanceof HTMLElement)) return [];
      return Array.from(
        d.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeForm();
        return;
      }
      if (e.key !== 'Tab') return;
      const d = document.querySelector('[data-client-form]');
      if (!(d instanceof HTMLElement)) return;
      const list = focusables();
      if (!list.length) return;
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !d.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const id = requestAnimationFrame(() => focusables()[0]?.focus());
    return () => {
      document.removeEventListener('keydown', onKey);
      cancelAnimationFrame(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formOpen]);

  // Pendant l'ouverture : arrière-plan non interactif (inert) et masqué aux
  // technologies d'assistance (aria-hidden) partout SAUF le scrim et la
  // dialog (jamais d'inert sur l'arbre qui la contient) ; le conteneur de
  // toasts reste accessible (retour d'erreur du déploiement). Défilement de
  // la page verrouillé (overflow du body) sans toucher à celui du contenu de
  // la modale (.client-create-body). États et focus restaurés à la fermeture
  // par le cleanup, APRÈS le retrait de inert (le focus revient au
  // déclencheur enregistré à l'ouverture).
  useEffect(() => {
    if (!formOpen) return;
    const scrim = document.getElementById('client-form-zone');
    if (!scrim) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const marked: Array<{ el: HTMLElement; ariaHidden: string | null; wasInert: boolean }> = [];
    const mark = (el: Element) => {
      if (!(el instanceof HTMLElement)) return;
      if (el.matches('.toast-host, script, [aria-live]')) return;
      marked.push({ el, ariaHidden: el.getAttribute('aria-hidden'), wasInert: el.hasAttribute('inert') });
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('inert', '');
    };
    const walk = (parent: Element) => {
      for (const child of Array.from(parent.children)) {
        if (child === scrim) continue;
        if (child.contains(scrim)) walk(child); // ancêtre de la dialog
        else mark(child); // bloc de fond (inert propage aux descendants)
      }
    };
    walk(document.body);
    return () => {
      document.body.style.overflow = prevOverflow;
      for (const { el, ariaHidden, wasInert } of marked) {
        // inert préexistant (ex. tiroir mobile) : restauré, pas supprimé.
        if (wasInert) el.setAttribute('inert', '');
        else el.removeAttribute('inert');
        if (ariaHidden === null) el.removeAttribute('aria-hidden');
        else el.setAttribute('aria-hidden', ariaHidden);
      }
      const opener = formOpener.current;
      // CTA « Nouvelle application » permanent en tête de rubrique (plus de
      // FAB) : le focus lui revient en haut, que l'ouverture ait été déclenchée
      // au clavier (opener = CTA) ou avec un clic qui n'a pas capturé le focus
      // (opener hors-CTA → premier CTA visible = ce même bouton unique).
      const isToggle = (el: Element | null | undefined): el is HTMLElement =>
        el instanceof HTMLElement &&
        el.matches('[data-client-form-toggle]') &&
        el.getClientRects().length > 0;
      let target: HTMLElement | null = isToggle(opener) ? opener : null;
      if (!target) {
        target =
          Array.from(document.querySelectorAll<HTMLElement>('[data-client-form-toggle]')).find(
            isToggle,
          ) ?? null;
      }
      target?.focus();
    };
  }, [formOpen]);

  async function subscribe(productId: string) {
    const product = products.find((p) => p.id === productId);
    const slug = product?.slug;
    if (!slug) return toast.error('Offre indisponible à la commande.');
    // Décision 3 (Bloc 1/4) : toute souscription passe par la procédure de
    // commande store (POST /store/checkout recrée l'abonnement ACTIVE).
    router.push(`/shop/${slug}`);
  }

  async function cancelSub(id: string) {
    const r = await cancelMySubscription(token, id);
    if (!r.ok) return toast.error(apiError(r, 'Impossible d’annuler.'));
    toast.ok('Souscription annulée.');
    void load(token);
  }

  // Bloc 4 : le flux « demander un service » a été supprimé — tout abonnement
  // passe par la procédure de commande store.

  // Accès support.
  async function generateCode() {
    const r = await generateSupportCode(token);
    if (!r.ok) return toast.error(apiError(r, 'Génération impossible.'));
    const d = r.data as { code: string; expiresAt: string };
    setShownCode(d.code);
    setCodeActive(true);
    setCodeExpiry(d.expiresAt);
    try {
      await navigator.clipboard?.writeText(d.code);
    } catch {
      /* clipboard indisponible — l'utilisateur recopie */
    }
    toast.info('Code affiché une seule fois — transmettez-le au support par téléphone.');
  }

  async function revokeCode() {
    const r = await revokeSupportCode(token);
    if (!r.ok) return toast.error(apiError(r, 'Révocation impossible.'));
    setCodeActive(false);
    setCodeExpiry(null);
    setShownCode(null);
    toast.ok('Code d’accès révoqué.');
  }

  // Tickets.
  async function openTicket() {
    if (!tSubject.trim() || !tBody.trim()) return;
    const r = await createTicket(token, { subject: tSubject.trim(), body: tBody.trim() });
    if (!r.ok) return toast.error(apiError(r, 'Ouverture impossible.'));
    setTSubject('');
    setTBody('');
    toast.ok('Ticket ouvert — le support vous répondra.');
    void loadTickets(token);
  }

  async function sendTicketReply(id: string) {
    const body = (ticketReply[id] ?? '').trim();
    if (!body) return;
    const r = await addTicketMessage(token, id, body);
    if (!r.ok) return toast.error(apiError(r, 'Réponse impossible.'));
    setTicketReply({ ...ticketReply, [id]: '' });
    toast.ok('Message ajouté.');
    void loadTickets(token);
  }

  // Déploiements (Phase 10bis).
  function onRepoChange(fullName: string) {
    setDepRepo(fullName);
    const repo = repos.find((x) => x.fullName === fullName);
    setDepBranch(repo?.defaultBranch ?? '');
  }

  // ── 17B.4F-C2 — service hébergement + intention d'idempotence ─────────────
  /** Services COMPATIBLES avec la cible courante (jeton seul, vérifié serveur). */
  const compatibleServices = hsOptions.filter((s) => s.compatible);

  /** Id envoyé : auto si UN SEUL compatible, choix explicite si plusieurs,
   *  absent sinon (le serveur décide alors — legacy prouvé ou refus 4xx). */
  function selectedHostingServiceId(): string | undefined {
    if (compatibleServices.length === 1) return compatibleServices[0]!.id;
    if (compatibleServices.length > 1) return hsChoice || undefined;
    return undefined;
  }

  /** Sélecteur affiché UNIQUEMENT quand plusieurs services sont compatibles. */
  function serviceSelect() {
    if (compatibleServices.length <= 1) return null;
    return (
      <Field
        label="Service hébergement"
        hint="Service qui accueillera cette application (vérifié côté serveur)."
      >
        <Select value={hsChoice} disabled={isImp} onChange={(e) => setHsChoice(e.target.value)}>
          <option value="">Choisir un service…</option>
          {compatibleServices.map((s) => (
            <option key={s.id} value={s.id}>
              {s.packNameSnapshot ?? 'Service'} — {s.id.slice(-6)}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  /** Vrai si un choix de service est requis mais pas encore fait. */
  const hsMissing = compatibleServices.length > 1 && !hsChoice;

  async function deploy() {
    if (!depRepo || depBusy || hsMissing) return;
    const body = {
      repoFullName: depRepo,
      branch: depBranch.trim() || 'main',
      subdomain: depSubdomain.trim() || undefined,
      hostingServiceId: selectedHostingServiceId(),
    };
    // Même identifiant sur retry/timeout/double-clic ; nouveau si payload modifié.
    const clientRequestId = intentFor(depIntent, body);
    setDepBusy(true);
    try {
      const r = await createDeployment(token, { ...body, clientRequestId });
      // Échec (dont 409 rejeu) ⇒ identité CONSERVÉE : aucun nouvel envoi auto.
      if (!r.ok) return toast.error(apiError(r, 'Déploiement impossible.'));
      depIntent.current = null; // intention aboutie → prochaine = nouvelle
      toast.ok('Déploiement déclenché — statut en direct ci-dessous.');
      void loadDeployments(token);
    } finally {
      setDepBusy(false);
    }
  }

  // Mode URL collée (Phase 10bis.5) : Détecter → préremplit la branche + le
  // build pack suggéré ; le client peut corriger Nom de l'app et Build pack.
  async function onDetect() {
    const url = depUrl.trim();
    if (!url) return;
    setDetecting(true);
    const r = await detectDeployment(token, url);
    setDetecting(false);
    if (!r.ok) return toast.error(apiError(r, 'Détection impossible.'));
    const d = r.data as DetectResult | null;
    if (!d) return toast.error('Détection impossible.');
    setDetected(d);
    setDepAppName(d.repoFullName?.split('/').pop() ?? '');
    setDepBuildPack(
      (BUILD_PACKS as readonly string[]).includes(d.suggestedBuildPack)
        ? (d.suggestedBuildPack as BuildPack)
        : 'nixpacks',
    );
    toast.ok(d.detail ? `Détecté — ${d.detail}` : 'Dépôt détecté — vérifiez puis déployez.');
  }

  async function deployUrl() {
    if (!detected?.repoUrl || depBusy || hsMissing) return;
    const body = {
      repoUrl: detected.repoUrl,
      branch: detected.defaultBranch, // branche auto (non éditée dans l'UI)
      buildPack: depBuildPack,
      appName: depAppName.trim() || undefined,
      subdomain: depSubdomain.trim() || undefined,
      hostingServiceId: selectedHostingServiceId(),
    };
    const clientRequestId = intentFor(depIntent, body);
    setDepBusy(true);
    try {
      const r = await createDeployment(token, { ...body, clientRequestId });
      if (!r.ok) return toast.error(apiError(r, 'Déploiement impossible.'));
      depIntent.current = null;
      toast.ok('Déploiement déclenché — statut en direct ci-dessous.');
      void loadDeployments(token);
    } finally {
      setDepBusy(false);
    }
  }

  /**
   * Suppression d'une app (Phase 13) : confirmation en deux temps, puis
   * DELETE /client/deployments/:id (app Coolify + CNAME supprimés best-effort,
   * quota libéré). Après suppression, le compteur d'apps du plan baisse.
   */
  async function deleteApp(d: Deployment) {
    if (deleting) return;
    if (confirmDel !== d.id) {
      setConfirmDel(d.id);
      return;
    }
    setConfirmDel(null);
    setDeleting(true);
    const r = await deleteMyDeployment(token, d.id);
    setDeleting(false);
    const label = d.appName ?? d.repoFullName.split('/').pop();
    if (!r.ok) return toast.error(apiError(r, 'Suppression impossible.'));
    // Contrat honnête : la suppression LOCALE et la libération du QUOTA sont
    // deux faits distincts — « quota libéré » n'est annoncé QUE si le serveur
    // confirme `freedQuota === true`. Réponse absente/incomplète ≠ succès.
    const body = (r.data ?? null) as {
      removed?: boolean;
      partial?: boolean;
      freedQuota?: boolean;
    } | null;
    if (
      !body ||
      typeof body.removed !== 'boolean' ||
      typeof body.freedQuota !== 'boolean'
    ) {
      toast.error(
        `Suppression non confirmée pour « ${label} » — vérifiez l'état de l'application ou contactez le support.`,
      );
    } else if (body.removed === false) {
      toast.error(
        `Suppression non concluante : « ${label} » est conservée (quota non libéré). Réessayez plus tard ou contactez le support.`,
      );
    } else if (body.partial) {
      toast.warn(
        `« ${label} » supprimée partiellement — un résidu est conservé (réessayez pour terminer).`,
      );
    } else if (body.freedQuota === true) {
      toast.ok(`Application « ${label} » supprimée — quota libéré.`);
    } else {
      // Suppression LOCALE prouvée, libération du quota NON prouvée.
      toast.warn(
        `Application « ${label} » supprimée — quota non libéré : votre compteur de slots reste inchangé.`,
      );
    }
    void loadDeployments(token);
  }

  async function onReturn() {
    try {
      await returnFromImpersonation(token);
    } catch {
      /* audit best-effort */
    }
    clearImpToken();
    router.replace(impKind === 'admin' ? '/manager/utilisateurs' : '/manager/support');
  }

  // Entrées de sidebar : rubriques + pages, avec les compteurs de rubrique
  // (comme les anciens onglets — source de vérité = API).
  const clientNav: NavSection[] = CLIENT_NAV.map((section) => ({
    ...section,
    items: section.items.map((item) => {
      if (item.href === '/client?rub=apps' && deployEnabled) {
        return { ...item, badge: { text: String(deployments.length), tone: 'info' as const } };
      }
      if (item.href === '/client?rub=help') {
        return { ...item, badge: { text: String(tickets.length), tone: 'info' as const } };
      }
      return item;
    }),
  }));
  const activeHref = `/client?rub=${rub}`;

  if (phase === 'loading') {
    return (
      <AppShell me={null} nav={CLIENT_NAV} activeHref={activeHref}>
        <PageLoading />
      </AppShell>
    );
  }

  if (phase === 'denied') {
    return (
      <AppShell me={null} nav={CLIENT_NAV} tenant={{ label: 'Espace client' }} activeHref={activeHref}>
        <div className="auth-wrap">
          <div className="auth-card">
            <h2>Connexion requise</h2>
            <p>Connecte-toi pour accéder à ton espace client.</p>
            <a className="btn-primary" href="/auth">
              Se connecter
            </a>
          </div>
        </div>
      </AppShell>
    );
  }

  const activeSub = subs.find((s) => s.status === 'ACTIVE') ?? null;
  const currentPack = activeSub?.product?.pack ?? null;
  const pendingCount = subs.filter((s) => s.status === 'PENDING').length;
  const availablePlans = products.filter((p) => p.status === 'ACTIVE' && p.pack);
  const banner = isImp ? (
    <ImpersonationBanner targetEmail={me?.email ?? ''} kind={impKind} onReturn={onReturn} />
  ) : null;

  return (
    <AppShell me={me} nav={clientNav} tenant={{ label: 'Espace client' }} banner={banner} activeHref={activeHref}>
        <div className="wrap-lg client-page">
          {/* ── En-tête : titre de rubrique + action (bloc compact) ──────── */}
          <div className="client-head">
            <div className="client-head-text">
              <h2>{RUB_TITRE[rub]}</h2>
            </div>
            <div className="client-head-act">
              {deployEnabled && (
                <button
                  type="button"
                  className="btn-primary"
                  data-client-form-toggle
                  aria-expanded={formOpen}
                  aria-controls="client-form-zone"
                  disabled={isImp}
                  onClick={onNewAppClick}
                >
                  <IconPlus /> Nouvelle application
                </button>
              )}
            </div>
          </div>

          {/* ── Modale « Nouvelle application » (correction complémentaire) ──
              Deux cartes de source (GitHub / URL) puis configuration et
              déploiement dans la MÊME modale — plus de formulaire dépliable
              intermédiaire ni de passage obligé par « Créer un nouveau
              projet ». Rendue ici, juste après le CTA : le Tab depuis le CTA
              entre directement dans la dialog (piège de focus). */}
          <div
            id="client-form-zone"
            className="client-create-scrim"
            hidden={!formOpen}
            onClick={formOpen ? closeForm : undefined}
          >
            {formOpen && (
              <div
                className="client-create client-form-zone"
                data-client-form
                role="dialog"
                aria-modal="true"
                aria-labelledby="client-create-title"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="client-create-head">
                  <h3 id="client-create-title">Nouvelle application</h3>
                  <button
                    type="button"
                    className="client-create-x"
                    aria-label="Fermer la fenêtre"
                    onClick={closeForm}
                  >
                    <IconX size={17} />
                  </button>
                </div>

                <div className="client-create-body">
                  <p className="client-create-intro">
                    D’où provient le code source de votre application ?
                  </p>

                  {/* Deux cartes sélectionnables (maquette proposal-C) */}
                  <div className="client-choices">
                    <button
                      type="button"
                      className={`client-choice${depTab === 'github' ? ' selected' : ''}`}
                      data-client-choice="github"
                      aria-pressed={depTab === 'github'}
                      disabled={isImp}
                      onClick={() => setDepTab('github')}
                    >
                      <span className="client-choice-icon" aria-hidden="true">
                        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
                        </svg>
                      </span>
                      <span className="client-choice-title">Depuis mon compte GitHub</span>
                      <span className="client-choice-desc">
                        Choisissez un dépôt de votre compte GitHub lié.
                      </span>
                    </button>

                    <button
                      type="button"
                      className={`client-choice${depTab === 'url' ? ' selected' : ''}`}
                      data-client-choice="url"
                      aria-pressed={depTab === 'url'}
                      disabled={isImp}
                      onClick={() => setDepTab('url')}
                    >
                      <span className="client-choice-icon" aria-hidden="true">
                        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                        </svg>
                      </span>
                      <span className="client-choice-title">Coller l’URL d’un dépôt</span>
                      <span className="client-choice-desc">
                        Collez l’URL d’un dépôt pris en charge.
                      </span>
                    </button>
                  </div>

                  {/* ── Étape suivante : configuration selon la source choisie ── */}
                  {!github ? (
                    <EmptyState>Chargement…</EmptyState>
                  ) : depTab === 'github' ? (
                    github.linked ? (
                      <div className="inline-form">
                        <Field label="Dépôt GitHub">
                          <Select
                            value={depRepo}
                            disabled={isImp}
                            onChange={(e) => onRepoChange(e.target.value)}
                          >
                            <option value="">Choisir un dépôt…</option>
                            {repos.map((r) => (
                              <option key={r.fullName} value={r.fullName}>
                                {r.fullName}
                                {r.private ? ' 🔒' : ''}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Branche">
                          <Input
                            className="input-sm"
                            placeholder="main"
                            value={depBranch}
                            disabled={isImp}
                            onChange={(e) => setDepBranch(e.target.value)}
                          />
                        </Field>
                        <Field
                          label="Sous-domaine (optionnel)"
                          hint="Libre ; vide = slug auto depuis le nom de l'app."
                        >
                          <Input
                            className="input-sm"
                            placeholder="mon-app"
                            value={depSubdomain}
                            disabled={isImp}
                            onChange={(e) => setDepSubdomain(e.target.value)}
                          />
                        </Field>
                        {serviceSelect()}
                        <Button disabled={isImp || !depRepo || depBusy || hsMissing} onClick={deploy}>
                          <IconPlus /> {depBusy ? 'Déploiement…' : 'Déployer'}
                        </Button>
                      </div>
                    ) : (
                      <div className="client-gh-off">
                        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                          Compte GitHub non lié : connectez la liaison GitHub existante pour
                          choisir directement l’un de vos dépôts.
                        </p>
                        <a className="btn-primary" href="/profil">
                          <IconKey /> Connecter GitHub
                        </a>
                        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                          La liaison est optionnelle — choisissez « Coller l’URL d’un dépôt » pour
                          déployer sans connexion GitHub.
                        </p>
                      </div>
                    )
                  ) : (
                    <div className="stack">
                      {!github.linked && (
                        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                          La liaison GitHub est optionnelle — collez simplement l&apos;URL de votre
                          dépôt. (Vous pouvez aussi <a href="/profil">lier votre compte GitHub</a> pour
                          choisir un dépôt.)
                        </p>
                      )}
                      <div className="inline-form">
                        <Field label="URL du dépôt git">
                          <Input
                            className="flex-1"
                            placeholder="https://github.com/vous/mon-projet.git"
                            value={depUrl}
                            disabled={isImp || detecting}
                            onChange={(e) => setDepUrl(e.target.value)}
                          />
                        </Field>
                        <Button
                          variant="secondary"
                          disabled={isImp || detecting || !depUrl.trim()}
                          onClick={onDetect}
                        >
                          {detecting ? 'Détection…' : 'Détecter'}
                        </Button>
                      </div>

                      {detected ? (
                        <div
                          className="stack"
                          style={{ padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--card-bg-2)' }}
                        >
                          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                            <div className="muted" style={{ fontSize: 13 }}>
                              Repo : <b style={{ color: 'var(--text)' }}>{detected.repoFullName ?? detected.repoUrl}</b>
                              {detected.language ? ` · ${detected.language}` : ''}
                            </div>
                            <div className="muted" style={{ fontSize: 13 }}>
                              Branche : <b style={{ color: 'var(--text)' }}>{detected.defaultBranch}</b>{' '}
                              (auto)
                            </div>
                          </div>
                          {detected.detail && (
                            <div className="muted" style={{ fontSize: 12.5 }}>{detected.detail}</div>
                          )}
                          <div className="inline-form">
                            <Field label="Nom de l’app" hint="Nom de l’application côté Coolify.">
                              <Input
                                className="input-sm"
                                value={depAppName}
                                disabled={isImp}
                                onChange={(e) => setDepAppName(e.target.value)}
                              />
                            </Field>
                            <Field label="Build pack" hint="Suggéré par la détection, modifiable.">
                              <Select
                                value={depBuildPack}
                                disabled={isImp}
                                onChange={(e) => setDepBuildPack(e.target.value as BuildPack)}
                              >
                                {BUILD_PACKS.map((b) => (
                                  <option key={b} value={b}>
                                    {b}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <Field
                              label="Sous-domaine (optionnel)"
                              hint="Libre ; vide = slug auto. Vous obtenez une URL en https://."
                            >
                              <Input
                                className="input-sm"
                                placeholder="mon-app"
                                value={depSubdomain}
                                disabled={isImp}
                                onChange={(e) => setDepSubdomain(e.target.value)}
                              />
                            </Field>
                            {serviceSelect()}
                            <Button
                              disabled={isImp || !detected.repoUrl || depBusy || hsMissing}
                              onClick={deployUrl}
                            >
                              <IconPlus /> {depBusy ? 'Déploiement…' : 'Déployer'}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        !detecting && (
                          <EmptyState>
                            Collez l&apos;URL du dépôt puis « Détecter » pour préremplir la branche
                            et le build pack.
                          </EmptyState>
                        )
                      )}
                    </div>
                  )}

                  {/* Quota d'apps du pack — compteur + barre (Phase 13). */}
                  {quota && (
                    <div
                      className="stack"
                      style={{
                        padding: '14px 16px',
                        border: '1px solid var(--border)',
                        borderRadius: 12,
                        background: 'var(--tint-blue-bg)',
                      }}
                    >
                      <UsageBar
                        label={`Quota d'applications — plan ${quota.pack.name}`}
                        used={quota.used}
                        limit={quota.limit}
                      />
                    </div>
                  )}
                </div>

                <div className="client-create-foot">
                  <Button variant="secondary" onClick={closeForm}>
                    Annuler
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* ── Bandeau « résumé d'hébergement » (proposition C) : données
              métier réelles uniquement — quota.used (SOURCE unique, inclut
              réservations/libérations en cours), jamais le compteur de cartes. */}
          <section className="client-quota" aria-label="Résumé d’hébergement">
            <div className="client-quota-headline">
              <span className="client-quota-label">Utilisation du quota</span>
              {availablePlans.length > 0 && (
                <button
                  type="button"
                  className="client-quota-upgrade"
                  disabled={isImp}
                   onClick={() => goRub('host')}
                >
                  Augmenter mon quota
                </button>
              )}
            </div>
            <p className="client-ctx">
              <b>{activeSub?.product?.name ?? 'Aucune offre active'}</b>
              {quota && (
                <>
                  {' '}
                  · {quota.used} / {quota.limit ?? '∞'} emplacements —{' '}
                  <span
                    className={`client-quota-pill${quota.quotaFull || (quota.remaining ?? 1) === 0 ? ' full' : ''}`}
                  >
                    {quota.limit == null
                      ? 'Quota illimité'
                      : quota.quotaFull
                        ? 'Quota atteint'
                        : plural(quota.remaining ?? 0, 'place restante', 'places restantes')}
                  </span>
                </>
              )}
            </p>
            {quota &&
              quota.limit != null &&
              quota.limit > 0 &&
              (quota.limit <= 12 ? (
                /* Indicateur segmenté : 1 segment par emplacement (≤ 12) */
                <div
                  className="client-quota-segments"
                  role="img"
                  aria-label={`${quota.used} emplacements occupés sur ${quota.limit}`}
                >
                  {Array.from({ length: quota.limit ?? 0 }, (_, i) => (
                    <span
                      key={i}
                      className={`client-seg${i < Math.min(quota.used, quota.limit ?? 0) ? ' filled' : ''}`}
                    />
                  ))}
                </div>
              ) : (
                /* Quota important : barre continue (aucune centaine de segments) */
                <div
                  className="client-quota-bar"
                  role="img"
                  aria-label={`${quota.used} emplacements occupés sur ${quota.limit}`}
                >
                  <div
                    className="client-quota-fill"
                    style={{
                      width: `${Math.min(100, Math.round((quota.used / (quota.limit ?? 1)) * 100))}%`,
                    }}
                  />
                </div>
              ))}
          </section>

        {/* ═══ RUBRIQUE 1 — APPLICATIONS ═══ */}
        <div
          className="client-panel"
          id="client-panel-apps"
          hidden={rub !== 'apps'}
        >
          {deployEnabled && (
            <div className="client-toolbar">
              <span className="muted">
                {plural(deployments.length, 'déploiement', 'déploiements')}
              </span>
              <Button variant="ghost" size="sm" disabled={isImp} onClick={() => loadDeployments(token)}>
                <IconRefresh /> Actualiser
              </Button>
            </div>
          )}

          {!deployEnabled ? (
            <EmptyState>
              Le déploiement d’applications n’est pas encore activé. Découvrez les offres dans
              « Hébergement &amp; abonnements ».
            </EmptyState>
          ) : deployments.length === 0 ? (
            <EmptyState>
              Aucune application pour l’instant. Utilisez « Nouvelle application » pour déployer
              votre premier dépôt.
            </EmptyState>
          ) : (
            <ul className="client-list">
              {deployments.map((d) => {
                const confirmed = confirmDel === d.id;
                const displayName = d.appName ?? d.repoFullName.split('/').pop() ?? 'App';
                const initial = (displayName.trim()[0] ?? 'A').toUpperCase();
                return (
                  <li key={d.id} className="client-item">
                    {/* Identité + statut + actions (carte proposition C) */}
                    <div className="client-card-head">
                      <span className="client-app-avatar" aria-hidden>
                        {initial}
                      </span>
                      <div className="client-card-id">
                        <div className="client-item-name">{displayName}</div>
                        <Badge tone={statusTone(DEP_TONE(d.status))}>
                          {DEP_STATUS_LABEL[d.status] ?? d.status}
                        </Badge>
                      </div>

                      <div className="client-item-actions" onClick={(e) => e.stopPropagation()}>
                        {d.fqdn && (
                          <a
                            className="btn-secondary btn-sm"
                            href={`https://${d.fqdn}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Ouvrir ↗
                          </a>
                        )}
                        <button
                          type="button"
                          id={`client-menu-btn-${d.id}`}
                          className="client-menu-btn"
                          aria-haspopup="menu"
                          aria-expanded={menuFor === d.id}
                          aria-label={`Actions pour ${displayName}`}
                          onClick={() => setMenuFor((m) => (m === d.id ? null : d.id))}
                        >
                          ⋯
                        </button>
                        {menuFor === d.id && (
                          <div className="client-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              className="client-menu-item danger"
                              disabled={isImp || deleting}
                              onClick={() => {
                                setMenuFor(null);
                                deleteApp(d);
                              }}
                            >
                              Supprimer l’application
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Corps : erreur (si échec), URL publique, dépôt, infos */}
                    <div className="client-item-main">
                      {d.status === 'FAILED' && (
                        <div className="client-item-error">
                          <b>Déploiement échoué.</b> L’application n’est pas en ligne : corrigez le
                          dépôt ou relancez le déploiement ; si le problème persiste, contactez
                          l’assistance.
                          {d.detail && (
                            <details className="client-item-details">
                              <summary>Voir les détails techniques</summary>
                              <pre>{d.detail}</pre>
                            </details>
                          )}
                        </div>
                      )}
                      {d.fqdn && (
                        <a
                          className="client-item-dom"
                          href={`https://${d.fqdn}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          https://{d.fqdn}
                        </a>
                      )}
                      <div className="client-card-rows">
                        <div className="client-detail-row">
                          <span className="client-detail-label">Dépôt source</span>
                          <span className="client-detail-val">{d.repoFullName}</span>
                        </div>
                        <div className="client-detail-row">
                          <span className="client-detail-label">Source</span>
                          <span className="client-detail-val">
                            branche {d.branch}
                            {d.buildPack ? ` · ${d.buildPack}` : ''}
                          </span>
                        </div>
                        {quota?.pack && (
                          <div className="client-detail-row">
                            <span className="client-detail-label">Ressources / app</span>
                            <span className="client-detail-val">
                              RAM {quota.pack.ramMb} Mo · CPU{' '}
                              {plural(quota.pack.cpuCores, 'cœur', 'cœurs')}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="client-item-meta">
                        <span className="muted" style={{ fontSize: 11.5 }}>
                          Créé le {new Date(d.createdAt).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {confirmed && (
                      <div className="client-confirm">
                        <span>
                          Supprimer « {displayName} » définitivement ?
                        </span>
                        <span className="client-confirm-act">
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={isImp || deleting}
                            onClick={() => deleteApp(d)}
                          >
                            {deleting ? 'Suppression…' : 'Confirmer'}
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setConfirmDel(null)}>
                            Annuler
                          </Button>
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ═══ RUBRIQUE 2 — HÉBERGEMENT & ABONNEMENTS ═══ */}
        <div
          className="client-panel"
          id="client-panel-host"
          hidden={rub !== 'host'}
        >
        <div className="mt">
          <div className="section-title">
            <h3>Mon plan d’hébergement</h3>
            <span className="muted">La mise à niveau conserve vos applications et vos données.</span>
          </div>

          <Panel
            title={activeSub ? 'Souscription active' : 'Aucune souscription active'}
                    sub={
                      activeSub
                        ? `${activeSub.product?.name ?? activeSub.productId} · souscrite le ${new Date(activeSub.createdAt).toLocaleDateString()}${
                            pendingCount > 0
                              ? ` · ${pendingCount} souscription${pendingCount > 1 ? 's' : ''} en attente`
                              : ''
                          }`
                        : 'Souscrivez à une offre ci-dessous pour déployer vos applications.'
                    }
          >
            {activeSub && currentPack ? (
              <div className="plan-card">
                <div className="plan-card-head">
                  <div>
                    <div className="plan-name">{currentPack.name}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      Pack d’hébergement actif
                    </div>
                  </div>
                  <Badge tone="ok">ACTIF</Badge>
                </div>
                <div className="plan-specs">
                  <span className="app-chip">RAM {currentPack.ramMb} Mo / app</span>
                  <span className="app-chip">
                    CPU {plural(currentPack.cpuCores, 'cœur', 'cœurs')} / app
                  </span>
                  {currentPack.storageLimit && (
                    <span className="app-chip">Disque {currentPack.storageLimit} Go</span>
                  )}
                  <span className="app-chip">
                    {currentPack.maxApps
                      ? `${plural(currentPack.maxApps, 'application', 'applications')} max`
                      : 'Applications illimitées'}
                  </span>
                  {currentPack.deploymentModule && (
                    <span className="app-chip">Module {currentPack.deploymentModule.code} — {currentPack.deploymentModule.name}</span>
                  )}
                </div>
              </div>
            ) : activeSub ? (
              <EmptyState>
                Souscription active sans pack d’hébergement rattaché : les limites du plan ne sont pas lisibles ici —
                contactez le support.
              </EmptyState>
            ) : (
              <EmptyState>
                {subs.length === 0
                  ? 'Commander une offre ci-dessous : une souscription active (payée) débloque le déploiement.'
                  : pendingCount > 0
                    ? 'Une souscription est en attente de confirmation — elle s’active après validation du paiement.'
                    : 'Votre souscription n’est pas active — passez une commande pour débloquer le déploiement.'}
              </EmptyState>
            )}
          </Panel>
        </div>

        {/* ── Souscriptions ──────────────────────────────────────────────── */}
        <div className="mt">
          <div className="section-title">
            <h3>Souscriptions</h3>
            <span className="muted">
              Chaque commande payée crée ou améliore votre abonnement.
            </span>
          </div>

          <Panel title="Mes souscriptions" sub="Historique de vos abonnements et mises à niveau.">
            {subs.length === 0 ? (
              <EmptyState>L&apos;une des offres ci-dessus crée votre première souscription.</EmptyState>
            ) : (
              <div className="stack">
                {subs.map((s) => (
                  <div key={s.id} className="status-row">
                    <span className="status-icon">
                      <IconServer />
                    </span>
                    <div className="status-row-main">
                      <div className="status-row-title">{s.product?.name ?? s.productId}</div>
                      <div className="status-row-sub">Souscription</div>
                    </div>
                    <Badge tone={statusTone(s.status)}>{SUB_STATUS_LABEL[s.status] ?? s.status}</Badge>
                    {!isImp && ['ACTIVE', 'SUSPENDED'].includes(s.status) && (
                      <Button size="sm" variant="secondary" onClick={() => cancelSub(s.id)}>
                        Annuler
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* Offres disponibles (existantes : souscrire / commander — inchangé) */}
        <div className="mt">
          <div className="section-title">
            <h3>Offres disponibles</h3>
            <span className="muted">
              Souscrivez ou changez de pack — vos applications et vos données sont conservées.
            </span>
          </div>
          <Panel title="Offres" sub="Consultez les offres disponibles.">
            {/* Offre d'upgrade : l'indisponibilité du changement de pack est
                présentée ICI, avant tout engagement dans un paiement (le refus
                serveur surviendrait seulement à la confirmation de commande).
                Action = assistance existante ; aucun jargon technique. */}
            {activeSub && (
              <div className="alert warn" role="alert" style={{ marginBottom: 12 }}>
                <b>Le changement d&apos;offre n&apos;est pas encore disponible en ligne.</b>{' '}
                Contactez l&apos;assistance pour connaître les possibilités.{' '}
                <button type="button" className="alert-retry" onClick={() => goRub('help')}>
                  Contacter l&apos;assistance
                </button>
              </div>
            )}
            {availablePlans.length === 0 ? (
              <EmptyState>Aucune offre disponible pour l&apos;instant.</EmptyState>
            ) : (
              <div className="stack">
                {availablePlans.map((p) => {
                  const isCurrent = !!activeSub && p.id === activeSub.productId;
                  return (
                    <div key={p.id} className="upgrade-row">
                      <div className="upgrade-main">
                        <div className="upgrade-title">{p.name}</div>
                        <div className="upgrade-sub">
                          {p.pack
                            ? `${p.pack.name} · ${p.pack.ramMb} Mo RAM · ${p.pack.cpuCores} CPU${p.pack.maxApps ? ` · ${p.pack.maxApps} apps` : ' · apps illimitées'}${p.pack.storageLimit ? ` · ${p.pack.storageLimit} Go` : ''}`
                            : 'Pack non configuré'}
                        </div>
                      </div>
                      {isCurrent ? (
                        <Badge tone="ok">Votre offre</Badge>
                      ) : activeSub ? (
                        /* Compte déjà abonné : aucune commande d'upgrade ne peut
                           aboutir (refus serveur au paiement) → on n'engage pas
                           le tunnel, on oriente vers l'assistance. */
                        <Button size="sm" variant="secondary" disabled={isImp} onClick={() => goRub('help')}>
                          Contacter l&apos;assistance
                        </Button>
                      ) : (
                        <Button size="sm" disabled={isImp} onClick={() => subscribe(p.id)}>
                          Souscrire
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>
        </div>

        {/* ═══ RUBRIQUE 3 — ASSISTANCE ═══ */}
        <div
          className="client-panel"
          id="client-panel-help"
          hidden={rub !== 'help'}
        >
        {/* ── Support & tickets ─────────────────────────────────────────── */}
        <div className="mt">
          <div className="section-title">
            <h3>Support &amp; assistance</h3>
            <span className="muted">Code d’accès en lecture seule + tickets.</span>
          </div>

          <div className="bottom-grid">
            <Panel
              title="Accès support"
              sub="Transmettez ce code à 6 chiffres au support (par téléphone) : il consultera votre espace en lecture seule."
            >
              {shownCode ? (
                <div className="stack">
                  <p className="muted" style={{ fontSize: 13 }}>
                    Code d&apos;accès (affiché une seule fois) :
                  </p>
                  <div className="row">
                    <code className="input-mono access-code">{shownCode}</code>
                    <Button variant="secondary" size="sm" onClick={revokeCode} disabled={isImp}>
                      Révoquer le code
                    </Button>
                  </div>
                  {codeExpiry && (
                    <p className="muted" style={{ fontSize: 12 }}>
                      Expire le {new Date(codeExpiry).toLocaleString()}.
                    </p>
                  )}
                </div>
              ) : codeActive ? (
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="muted" style={{ fontSize: 13 }}>
                    Un code est actif jusqu&apos;au {codeExpiry ? new Date(codeExpiry).toLocaleString() : '—'}.
                  </span>
                  <Button variant="secondary" size="sm" onClick={revokeCode} disabled={isImp}>
                    Révoquer
                  </Button>
                </div>
              ) : (
                <Button onClick={generateCode} disabled={isImp}>
                  Générer un code
                </Button>
              )}
            </Panel>

            <Panel
              title="Mes tickets"
              sub="Le support vous répond jusqu’à résolution ; la demande est transmise aux équipes concernées si besoin."
            >
              {!isImp && (
                <div className="stack mb">
                  <div className="inline-form">
                    <Field label="Sujet">
                      <Input value={tSubject} onChange={(e) => setTSubject(e.target.value)} />
                    </Field>
                    <Button onClick={openTicket} disabled={!tSubject.trim() || !tBody.trim()}>
                      Ouvrir un ticket
                    </Button>
                  </div>
                  <Field label="Description du problème">
                    <Input value={tBody} onChange={(e) => setTBody(e.target.value)} />
                  </Field>
                </div>
              )}

              {tickets.length === 0 ? (
                <EmptyState>Aucun ticket pour l&apos;instant.</EmptyState>
              ) : (
                <div className="stack">
                  {tickets.map((t) => {
                    const open = openTicketId === t.id;
                    return (
                      <div key={t.id} className="panel ticket-msg">
                        <button
                          type="button"
                          className="status-row"
                          style={{ width: '100%', background: 'transparent', border: 0, textAlign: 'left', cursor: 'pointer' }}
                          onClick={() => setOpenTicketId(open ? null : t.id)}
                        >
                          <div className="status-row-main">
                            <div className="status-row-title">{t.subject}</div>
                            <div className="status-row-sub">
                              {TICKET_STATUS_LABEL[t.status] ?? t.status}
                              {t.escalatedTo && ' · prise en charge renforcée'} ·{' '}
                              {new Date(t.updatedAt).toLocaleString()}
                            </div>
                          </div>
                          <Badge tone={statusTone(TICKET_TONE(t.status))}>{TICKET_STATUS_LABEL[t.status] ?? t.status}</Badge>
                        </button>

                        {open && (
                          <div className="stack mt" style={{ padding: '0 4px' }}>
                            {t.messages?.map((m) => (
                              <div key={m.id} className="ticket-msg">
                                <div className="row" style={{ gap: 8 }}>
                                  <b style={{ fontSize: 12.5 }}>{m.authorEmail}</b>
                                  <span className="muted" style={{ fontSize: 11.5 }}>
                                    {new Date(m.createdAt).toLocaleString()}
                                  </span>
                                </div>
                                <div className="mt-sm" style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>
                                  {m.body}
                                </div>
                              </div>
                            ))}
                            {!isImp && (
                              <div className="row">
                                <Input
                                  className="flex-1"
                                  placeholder="Votre réponse…"
                                  value={ticketReply[t.id] ?? ''}
                                  onChange={(e) => setTicketReply({ ...ticketReply, [t.id]: e.target.value })}
                                />
                                <Button
                                  size="sm"
                                  disabled={!(ticketReply[t.id] ?? '').trim()}
                                  onClick={() => sendTicketReply(t.id)}
                                >
                                  Répondre
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          </div>
        </div>
        </div>
      </div>
    </AppShell>
  );
}

/** Map a ticket status to a statusTone-compatible value for the badge. */
function TICKET_TONE(status: string): string {
  if (status === 'RESOLVED') return 'ACTIVE';
  if (status === 'CLOSED') return 'CANCELLED';
  if (status === 'WAITING_CLIENT') return 'PENDING';
  if (status === 'IN_PROGRESS') return 'REQUESTED';
  return status;
}

/** Map a deployment status to a statusTone-compatible value for the badge. */
function DEP_TONE(status: string): string {
  if (status === 'ACTIVE') return 'ACTIVE';
  if (status === 'FAILED') return 'CANCELLED';
  if (status === 'DEPLOYING') return 'PENDING';
  if (status === 'PENDING') return 'REQUESTED';
  return status;
}
