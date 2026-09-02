// Phase 9 (ADR-010) — tests du transport RÉEL contre des simulateurs loopback
// (api panels Coolify/Hestia locales) : aucun réseau externe, timeout court.
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { PanelTransportFactory } from './panel-transport.factory';

describe('PanelTransportFactory / NodePanelTransport', () => {
  const factory = new PanelTransportFactory();
  // Timeout court : les échecs réseau sont immédiats en loopback.
  const timeoutMs = 2_000;

  /** Démarre un mini-serveur HTTP qui répond selon `handler` ; renvoie sa base URL. */
  function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
    const server = http.createServer(handler);
    return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () =>
            new Promise((done) => {
              server.close(() => done());
            }),
        });
      });
    });
  }

  describe('Coolify (GET /version, Bearer)', () => {
    it('returns ok with the panel version on 200 + JSON version', async () => {
      let authHeader: string | undefined;
      const srv = await serve((req, res) => {
        authHeader = req.headers.authorization;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '4.0.0-beta' }));
      });
      try {
        const transport = factory.create(timeoutMs);
        const out = await transport.verify({
          provider: 'COOLIFY',
          baseUrl: `${srv.url}/api/v1`,
          token: 'tok-123',
          strictTls: true,
        });
        expect(out.ok).toBe(true);
        expect(out.version).toBe('4.0.0-beta');
        expect(out.detail).toContain('Coolify API');
        expect(authHeader).toBe('Bearer tok-123');
      } finally {
        await srv.close();
      }
    });

    it('returns a clear rejection on 401 (bad token)', async () => {
      let authHeader: string | undefined;
      const srv = await serve((req, res) => {
        authHeader = req.headers.authorization;
        res.writeHead(401);
        res.end('unauthorized');
      });
      try {
        const out = await factory.create(timeoutMs).verify({
          provider: 'COOLIFY',
          baseUrl: `${srv.url}/api/v1`,
          token: 'mauvais',
          strictTls: true,
        });
        expect(out.ok).toBe(false);
        expect(out.detail).toBe('Jeton API rejeté (401)');
        expect(authHeader).toContain('Bearer');
      } finally {
        await srv.close();
      }
    });
  });

  describe('Hestia (GET ?cmd=sysinfo&format=json&returncode=yes, Basic)', () => {
    it('returns ok on 200 + returncode 0 and uses the api user by default', async () => {
      let authHeader: string | undefined;
      let query: string | undefined;
      const srv = await serve((req, res) => {
        authHeader = req.headers.authorization;
        query = (req.url ?? '').split('?')[1];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ returncode: '0', sysinfo: 'probe' }));
      });
      try {
        const out = await factory.create(timeoutMs).verify({
          provider: 'HESTIA',
          baseUrl: `${srv.url}/api/`,
          token: 'access-key',
          strictTls: true,
        });
        expect(out.ok).toBe(true);
        expect(out.detail).toContain('Hestia API');
        const expected = Buffer.from(`api:access-key`).toString('base64');
        expect(authHeader).toBe(`Basic ${expected}`);
        expect(query).toContain('cmd=sysinfo');
        expect(query).toContain('format=json');
        expect(query).toContain('returncode=yes');
      } finally {
        await srv.close();
      }
    });

    it('supports an explicit api user', async () => {
      let authHeader: string | undefined;
      const srv = await serve((req, res) => {
        authHeader = req.headers.authorization;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ returncode: '0' }));
      });
      try {
        await factory.create(timeoutMs).verify({
          provider: 'HESTIA',
          baseUrl: `${srv.url}/api/`,
          token: 'k',
          user: 'admin-api',
          strictTls: true,
        });
        const expected = Buffer.from(`admin-api:k`).toString('base64');
        expect(authHeader).toBe(`Basic ${expected}`);
      } finally {
        await srv.close();
      }
    });

    it('returns a poor result when Hestia rejects the command (returncode != 0)', async () => {
      const srv = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ returncode: '2', error: 'Access denied' }));
      });
      try {
        const out = await factory.create(timeoutMs).verify({
          provider: 'HESTIA',
          baseUrl: `${srv.url}/api/`,
          token: 'bad',
          strictTls: true,
        });
        expect(out.ok).toBe(false);
        expect(out.detail).toContain('returncode 2');
      } finally {
        await srv.close();
      }
    });

    it('returns a clear rejection on 403 (bad access key)', async () => {
      const srv = await serve((_req, res) => {
        res.writeHead(403);
        res.end('forbidden');
      });
      try {
        const out = await factory.create(timeoutMs).verify({
          provider: 'HESTIA',
          baseUrl: `${srv.url}/api/`,
          token: 'bad',
          strictTls: true,
        });
        expect(out.ok).toBe(false);
        expect(out.detail).toBe("Jeton d'accès rejeté (403)");
      } finally {
        await srv.close();
      }
    });

    it('parses best-effort metrics from the sysinfo output (Phase 9bis)', async () => {
      const target = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            returncode: '0',
            sysinfo: `MemTotal: 16777216 kB\ncpu cores : 8\nDisk: 200 GB`,
          }),
        );
      });
      try {
        const out = await factory.create(timeoutMs).verify({
          provider: 'HESTIA',
          baseUrl: `${target.url}/api/`,
          token: 'k',
          strictTls: true,
        });
        // MemTotal 16777216 kB = 16384 Mo ; "cpu cores : 8" ; "Disk: 200 GB".
        expect(out.metrics).toEqual({ ramMb: 16384, cpuCores: 8, diskGb: 200 });
      } finally {
        await target.close();
      }
    });
  });

  it('reports a refused connection when the panel is unreachable', async () => {
    // Port réel puis fermé = connexion refusée immédiate.
    const srv = await serve((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const port = new URL(srv.url).port;
    await srv.close(); // libère le port → ECONNREFUSED au prochain connect
    const out = await factory.create(timeoutMs).verify({
      provider: 'COOLIFY',
      baseUrl: `http://127.0.0.1:${port}/api/v1`,
      token: 'x',
      strictTls: true,
    });
    expect(out.ok).toBe(false);
    expect(out.detail).toBe('Coolify API : Connexion refusée');
  });
});
