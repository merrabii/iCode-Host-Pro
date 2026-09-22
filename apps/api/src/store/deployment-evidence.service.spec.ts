import { DeploymentEvidenceService } from './deployment-evidence.service';
import { CoolifyEvidenceConnector } from './evidence-connectors/coolify-evidence.connector';
import {
  DeploymentEvidenceConnector,
  ProviderDeploymentContext,
  ProviderDeploymentObservation,
} from './deployment-evidence';

// 17B.4B — couche ÉVIDENCE (orchestrateur des preuves, agnostique provider).
// Invariants : jamais de mutation externe (transport LECTURE SEULE) ; HTTP
// UNIQUEMENT pour une politique HTTP_REQUIRED ; preuve connecteur UNIQUEMENT
// pour CONNECTOR_REQUIRED ; provider injoignable/indéchiffrable/absent → repli
// HTTP puis UNKNOWN — aucune décision inventée. Prisma/transport/HTTP mockés.
describe('DeploymentEvidenceService — orchestration des preuves', () => {
  const coolify = new CoolifyEvidenceConnector();

  const fakeConnector: DeploymentEvidenceConnector = {
    providerKind: 'FAKE',
    resolveResourceId: jest.fn((c: ProviderDeploymentContext) => c.resourceId),
    hasStatusChannel: () => true,
    normalize: jest.fn((raw: string): ProviderDeploymentObservation => ({
      lifecycle: raw === 'fk-running' ? 'RUNNING' : 'UNKNOWN',
      health: 'UNKNOWN',
      proofPolicy: 'NO_PROOF_AVAILABLE',
    })),
    prove: jest.fn().mockResolvedValue({ satisfied: true }),
  };

  const server = {
    id: 'srv1',
    panelProvider: 'COOLIFY',
    apiBaseUrl: 'http://panel.example.com/api/v1',
    apiTokenEnc: 'enc:secret',
    strictTls: true,
  };

  const deployment = {
    id: 'd1',
    coolifyUuid: 'app-1',
    fqdn: 'app.example.com',
    serverId: 'srv1',
  };

  let prisma: { deployment: { findUnique: jest.Mock }; server: { findUnique: jest.Mock } };
  let transport: Record<string, jest.Mock>;
  let panelFactory: { create: jest.Mock };
  let crypto: { decrypt: jest.Mock };
  let httpAvailability: { isServed: jest.Mock };
  let service: DeploymentEvidenceService;

  beforeEach(() => {
    prisma = {
      deployment: {
        findUnique: jest.fn().mockResolvedValue(deployment),
      },
      server: {
        findUnique: jest.fn().mockResolvedValue(server),
      },
    };
    transport = {
      deploymentStatus: jest.fn(),
      createGitApp: jest.fn(),
      deployApp: jest.fn(),
      applyAppLimits: jest.fn(),
      setAppDomain: jest.fn(),
      deleteApplication: jest.fn(),
      applyNodePort: jest.fn(),
      resolveExposedPort: jest.fn(),
    };
    panelFactory = { create: jest.fn(() => transport) };
    crypto = { decrypt: jest.fn().mockReturnValue('tok-coolify') };
    httpAvailability = { isServed: jest.fn().mockResolvedValue(true) };
    service = new DeploymentEvidenceService(
      prisma as never,
      panelFactory as never,
      crypto as never,
      httpAvailability as never,
      [coolify, fakeConnector],
    );
  });

  it('aucune mutation externe : le transport n’est utilisé qu’en LECTURE (deploymentStatus)', async () => {
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'running:healthy' });
    await service.observe('d1');

    expect(transport.createGitApp).not.toHaveBeenCalled();
    expect(transport.deployApp).not.toHaveBeenCalled();
    expect(transport.applyAppLimits).not.toHaveBeenCalled();
    expect(transport.setAppDomain).not.toHaveBeenCalled();
    expect(transport.deleteApplication).not.toHaveBeenCalled();
    expect(transport.applyNodePort).not.toHaveBeenCalled();
    expect(transport.resolveExposedPort).not.toHaveBeenCalled();
  });

  it('PROVIDER_SUFFICIENT (running:healthy) ⇒ AUCUN appel HTTP (le statut suffit)', async () => {
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'running:healthy' });

    const obs = await service.observe('d1');

    expect(obs.lifecycle).toBe('RUNNING');
    expect(obs.health).toBe('HEALTHY');
    expect(obs.proofPolicy).toBe('PROVIDER_SUFFICIENT');
    expect(obs.httpServed).toBeUndefined();
    // Cible construite avec le jeton DÉCHIFFRÉ et la resourceId opaque résolue.
    expect(transport.deploymentStatus).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'COOLIFY', baseUrl: server.apiBaseUrl, token: 'tok-coolify', strictTls: true }),
      'app-1',
    );
    expect(crypto.decrypt).toHaveBeenCalledWith('enc:secret');
    expect(httpAvailability.isServed).not.toHaveBeenCalled();
  });

  it('running → HTTP_REQUIRED : la preuve HTTP est appelée DANS CE CAS UNIQUEMENT', async () => {
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'running' });
    httpAvailability.isServed.mockResolvedValue(true);

    const obs = await service.observe('d1');

    expect(obs.proofPolicy).toBe('HTTP_REQUIRED');
    expect(obs.httpServed).toBe(true);
    expect(httpAvailability.isServed).toHaveBeenCalledWith('app.example.com');
  });

  it('running + HTTP injoignable (false) ⇒ httpServed false, jamais d’invention', async () => {
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'running:unhealthy' });
    httpAvailability.isServed.mockResolvedValue(false);

    const obs = await service.observe('d1');

    expect(obs.health).toBe('UNHEALTHY');
    expect(obs.proofPolicy).toBe('HTTP_REQUIRED');
    expect(obs.httpServed).toBe(false);
  });

  it('statut brut inconnu → UNKNOWN (l’état courant est conservé par le moteur)', async () => {
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'boom-unknown' });

    const obs = await service.observe('d1');

    expect(obs.lifecycle).toBe('UNKNOWN');
    expect(obs.proofPolicy).toBe('NO_PROOF_AVAILABLE');
    expect(httpAvailability.isServed).not.toHaveBeenCalled();
  });

  it('CONNECTOR_REQUIRED → preuve propre du connecteur appelée et portée', async () => {
    (fakeConnector.normalize as unknown as jest.Mock).mockReturnValue({
      lifecycle: 'RUNNING',
      health: 'UNKNOWN',
      proofPolicy: 'CONNECTOR_REQUIRED',
    });
    (fakeConnector.prove as unknown as jest.Mock).mockResolvedValue({ satisfied: true, detail: 'health-ok' });
    prisma.server.findUnique.mockResolvedValue({ ...server, panelProvider: 'FAKE' });
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'fk-running' });

    const obs = await service.observe('d1');

    expect(obs.connectorProof).toEqual(
      expect.objectContaining({ label: 'preuve connecteur', satisfied: true, detail: 'health-ok' }),
    );
    expect(fakeConnector.prove).toHaveBeenCalledWith({
      deployment: expect.objectContaining({ deploymentId: 'd1', resourceId: 'app-1', fqdn: 'app.example.com' }),
      observation: expect.objectContaining({ proofPolicy: 'CONNECTOR_REQUIRED' }),
    });
    // Preuve connecteur ⇒ AUCUNE preuve HTTP.
    expect(httpAvailability.isServed).not.toHaveBeenCalled();
  });

  it('preuve connecteur en échec (reject) ⇒ observation conservée, jamais de throw, aucun faux satisfied', async () => {
    (fakeConnector.normalize as unknown as jest.Mock).mockReturnValue({
      lifecycle: 'RUNNING',
      health: 'UNKNOWN',
      proofPolicy: 'CONNECTOR_REQUIRED',
    });
    (fakeConnector.prove as unknown as jest.Mock).mockRejectedValue(new Error('health down'));
    prisma.server.findUnique.mockResolvedValue({ ...server, panelProvider: 'FAKE' });
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'fk-running' });

    const obs = await service.observe('d1');

    expect(obs.proofPolicy).toBe('CONNECTOR_REQUIRED');
    expect(obs.connectorProof).toBeUndefined();
  });

  it('transport injoignable (reject) ⇒ UNKNOWN, aucun appel HTTP, jamais un throw au moteur', async () => {
    transport.deploymentStatus.mockRejectedValue(new Error('ECONNREFUSED'));

    const obs = await service.observe('d1');

    expect(obs.lifecycle).toBe('UNKNOWN');
    expect(obs.proofPolicy).toBe('NO_PROOF_AVAILABLE');
    expect(httpAvailability.isServed).not.toHaveBeenCalled();
  });

  it('app sans uuid provider ⇒ aucun statut lisible → repli HTTP seul (si fqdn)', async () => {
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'running' });
    prisma.deployment.findUnique.mockResolvedValue({ ...deployment, coolifyUuid: null });

    const obs = await service.observe('d1');

    expect(obs.proofPolicy).toBe('HTTP_REQUIRED');
    expect(httpAvailability.isServed).toHaveBeenCalledWith('app.example.com');
    expect(transport.deploymentStatus).not.toHaveBeenCalled();
  });

  it('pas de serveur (serverId null) ⇒ repli HTTP seul sur le fqdn', async () => {
    prisma.deployment.findUnique.mockResolvedValue({ ...deployment, serverId: null });

    const obs = await service.observe('d1');

    expect(obs.proofPolicy).toBe('HTTP_REQUIRED');
    expect(httpAvailability.isServed).toHaveBeenCalledWith('app.example.com');
    expect(transport.deploymentStatus).not.toHaveBeenCalled();
  });

  it('provider inconnu (ex. HESTIA sans connecteur) ⇒ repli HTTP seul, jamais d’invention', async () => {
    prisma.server.findUnique.mockResolvedValue({ ...server, panelProvider: 'HESTIA' });

    const obs = await service.observe('d1');

    expect(obs.proofPolicy).toBe('HTTP_REQUIRED');
    expect(httpAvailability.isServed).toHaveBeenCalledWith('app.example.com');
    expect(transport.deploymentStatus).not.toHaveBeenCalled();
  });

  it('jeton indéchiffrable ⇒ aucun appel transport (jamais de token en clair) → repli HTTP', async () => {
    crypto.decrypt.mockImplementation(() => {
      throw new Error('bad key');
    });
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'running' });

    const obs = await service.observe('d1');

    expect(transport.deploymentStatus).not.toHaveBeenCalled();
    expect(obs.proofPolicy).toBe('HTTP_REQUIRED');
  });

  it('serveur sans apiBaseUrl/apiTokenEnc ⇒ aucun canal → repli HTTP', async () => {
    prisma.server.findUnique.mockResolvedValue({ ...server, apiBaseUrl: null, apiTokenEnc: null });
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'running' });

    const obs = await service.observe('d1');

    expect(transport.deploymentStatus).not.toHaveBeenCalled();
    expect(obs.proofPolicy).toBe('HTTP_REQUIRED');
  });

  it('aucune preuve POSSIBLE (ni statut, ni fqdn) ⇒ UNKNOWN, aucun appel réseau', async () => {
    prisma.deployment.findUnique.mockResolvedValue({ ...deployment, serverId: null, fqdn: null });

    const obs = await service.observe('d1');

    expect(obs.lifecycle).toBe('UNKNOWN');
    expect(obs.proofPolicy).toBe('NO_PROOF_AVAILABLE');
    expect(httpAvailability.isServed).not.toHaveBeenCalled();
    expect(transport.deploymentStatus).not.toHaveBeenCalled();
  });

  it('HTTP_REQUIRED sans fqdn ⇒ observation intacte (pas de httpServed), aucun appel HTTP', async () => {
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'running' });
    prisma.deployment.findUnique.mockResolvedValue({ ...deployment, fqdn: null });

    const obs = await service.observe('d1');

    expect(obs.proofPolicy).toBe('HTTP_REQUIRED');
    expect(obs.httpServed).toBeUndefined();
    expect(httpAvailability.isServed).not.toHaveBeenCalled();
  });

  it('connecteur réel Coolify engagé par providerKind (COOLIFY) ⇒ matrice appliquée', async () => {
    prisma.server.findUnique.mockResolvedValue(server);
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'running:healthy' });

    const obs = await service.observe('d1');

    expect(obs).toEqual(expect.objectContaining({ lifecycle: 'RUNNING', health: 'HEALTHY' }));
    expect(transport.deploymentStatus).toHaveBeenCalledWith(expect.objectContaining({ provider: 'COOLIFY' }), 'app-1');
  });

  it('observe recharge la row elle-même : LA couche évidence seule lit serverId/fqdn/resourceId (le moteur n’envoie qu’un deploymentId)', async () => {
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'running:healthy' });

    await service.observe('d1');

    // Aucun champ provider transmis par le moteur : seule cette couche recharge
    // la row et les données provider dans un select INTERNE.
    expect(prisma.deployment.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd1' },
        select: expect.objectContaining({ id: true, serverId: true, fqdn: true, coolifyUuid: true }),
      }),
    );
  });

  it('adapter de frontière : la colonne historique de la row devient resourceId opaque — le connecteur ne reçoit JAMAIS de propriété coolifyUuid', async () => {
    // Prisma retourne la colonne historique COOLIFY (vocabulaire interne)…
    prisma.deployment.findUnique.mockResolvedValue({ ...deployment, coolifyUuid: 'abc123' });
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'running:healthy' });
    const spy = jest.spyOn(coolify, 'resolveResourceId');

    const obs = await service.observe('d1');

    // … la couche évidence convertit localement en resourceId opaque et le
    // connecteur reçoit UNIQUEMENT ce contexte générique.
    expect(obs).toEqual(expect.objectContaining({ lifecycle: 'RUNNING', health: 'HEALTHY' }));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'd1', resourceId: 'abc123', fqdn: 'app.example.com' }),
    );
    const context = spy.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect('coolifyUuid' in context).toBe(false);
    expect(context.resourceId).toBe('abc123');
    // Le statut panel est lu via le resourceId opaque, jamais via un champ Coolify.
    expect(transport.deploymentStatus).toHaveBeenCalledWith(expect.objectContaining({ provider: 'COOLIFY' }), 'abc123');
  });

  it('déploiement introuvable ⇒ UNKNOWN (état conservé), aucun appel réseau, jamais un throw', async () => {
    prisma.deployment.findUnique.mockResolvedValue(null);
    transport.deploymentStatus.mockResolvedValue({ rawStatus: 'running:healthy' });

    const obs = await service.observe('missing');

    expect(obs).toEqual(expect.objectContaining({ lifecycle: 'UNKNOWN', proofPolicy: 'NO_PROOF_AVAILABLE' }));
    expect(transport.deploymentStatus).not.toHaveBeenCalled();
    expect(httpAvailability.isServed).not.toHaveBeenCalled();
  });
});