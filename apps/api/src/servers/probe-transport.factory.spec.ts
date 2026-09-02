import * as http from 'node:http';
import * as net from 'node:net';
import { ProbeTransportFactory } from './probe-transport.factory';

// Probe transport réel testé sur loopback uniquement (déterministe, aucun
// réseau externe requis, aucune API à mocker — on vérifie le vrai comportement).
describe('ProbeTransportFactory (Phase 8, ADR-025)', () => {
  const factory = new ProbeTransportFactory();

  async function listen(server: net.Server | http.Server): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        resolve(addr.port);
      });
    });
  }

  it('reports HTTP reachable with status on an http endpoint', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const port = await listen(server);
    try {
      const result = await factory
        .create()
        .probe({ host: '127.0.0.1', port, strictTls: false, probeMode: 'http' });
      expect(result.ok).toBe(true);
      expect(result.httpStatus).toBe(200);
      expect(result.detail).toMatch(/^HTTP 200 /);
      expect(typeof result.latencyMs).toBe('number');
    } finally {
      server.close();
    }
  });

  it('reports TCP reachable on an ssh-like port', async () => {
    const server = net.createServer((sock) => sock.end());
    const port = await listen(server);
    try {
      const result = await factory.create().probe({ host: '127.0.0.1', port, strictTls: true });
      expect(result.ok).toBe(true);
      expect(result.detail).toMatch(new RegExp(`^TCP ${port} : accessible`));
    } finally {
      server.close();
    }
  });

  it('reports connection refused when nothing listens', async () => {
    const server = net.createServer((sock) => sock.end());
    const port = await listen(server);
    await new Promise<void>((r) => server.close(() => r()));

    const result = await factory.create().probe({ host: '127.0.0.1', port, strictTls: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('Connexion refusée');
  });

  it('reports host not found (or timeout) for an unknown hostname', async () => {
    // Sur certaines machines/réseaux, la résolution du TLD `.invalid` aboutit à un
    // EAI_AGAIN immédiat (Hôte introuvable), ailleurs à un ENOTFOUND bloquant le
    // socket jusqu'au timeout. Les deux sont des échecs de sonde légitimes.
    const result = await factory
      .create(300)
      .probe({ host: 'non.existant.icode.invalid', port: 22, strictTls: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Hôte introuvable|Délai dépassé/);
  });
});