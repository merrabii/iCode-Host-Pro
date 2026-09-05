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

  describe('Phase 10bis — Coolify deploy ops (POST/GET, Bearer, loopback)', () => {
    const target = {
      provider: 'COOLIFY' as const,
      baseUrl: '', // rempli par test (URL du mini-serveur)
      token: 'tok-deploy',
      strictTls: true,
    };
    const base = (url: string) => ({ ...target, baseUrl: `${url}/api/v1` });

    it('createGitApp POSTs /applications/public (route réelle Coolify 4.1.x, vérifiée live) with the git repo + branch + build pack and returns the app uuid', async () => {
      let method = '';
      let path = '';
      let authHeader: string | undefined;
      let body = '';
      const srv = await serve((req, res) => {
        method = req.method ?? '';
        path = req.url ?? '';
        authHeader = req.headers.authorization;
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ uuid: 'app-123', name: 'my-app' }));
        });
      });
      try {
        const out = await factory.create(timeoutMs).createGitApp(base(srv.url), {
          repoUrl: 'https://github.com/owner/repo.git',
          branch: 'main',
          serviceName: 'Mon service',
        });
        expect(out.uuid).toBe('app-123');
        expect(method).toBe('POST');
        expect(path).toBe('/api/v1/applications/public');
        expect(authHeader).toBe('Bearer tok-deploy');
        const parsed = JSON.parse(body) as Record<string, string>;
        expect(parsed.git_repository).toBe('https://github.com/owner/repo.git');
        expect(parsed.git_branch).toBe('main');
        expect(parsed.name).toBe('Mon service');
        expect(parsed.build_pack).toBe('nixpacks');
        expect(parsed.project_uuid).toBe('0');
        expect(parsed.environment_name).toBe('production');
      } finally {
        await srv.close();
      }
    });

    it('createGitApp forwards an explicit buildPack + appName (Phase 10bis.5 URL mode)', async () => {
      let body = '';
      const srv = await serve((req, res) => {
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ uuid: 'app-url-1' }));
        });
      });
      try {
        const out = await factory.create(timeoutMs).createGitApp(base(srv.url), {
          repoUrl: 'https://gitlab.com/foo/bar.git',
          branch: 'develop',
          serviceName: 'Mon service',
          buildPack: 'dockerfile',
          appName: 'mon-app-personnalisee',
        });
        expect(out.uuid).toBe('app-url-1');
        const parsed = JSON.parse(body) as Record<string, string>;
        expect(parsed.build_pack).toBe('dockerfile');
        expect(parsed.name).toBe('mon-app-personnalisee');
        expect(parsed.git_repository).toBe('https://gitlab.com/foo/bar.git');
        expect(parsed.git_branch).toBe('develop');
      } finally {
        await srv.close();
      }
    });

    it('createGitApp rejects with a readable message when Coolify returns no uuid', async () => {
      const srv = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      try {
        await expect(
          factory.create(timeoutMs).createGitApp(base(srv.url), {
            repoUrl: 'https://github.com/o/r.git',
            branch: 'main',
            serviceName: 'x',
          }),
        ).rejects.toThrow(/uuid/);
      } finally {
        await srv.close();
      }
    });

    it('createGitApp rejects with the HTTP status on 401 (bad token)', async () => {
      const srv = await serve((_req, res) => {
        res.writeHead(401);
        res.end('unauthorized');
      });
      try {
        await expect(
          factory.create(timeoutMs).createGitApp(base(srv.url), {
            repoUrl: 'https://github.com/o/r.git',
            branch: 'main',
            serviceName: 'x',
          }),
        ).rejects.toThrow(/401/);
      } finally {
        await srv.close();
      }
    });

    it('deployApp POSTs /deploy (route réelle Coolify 4.1.x, vérifiée live) with uuid+force and resolves on 200', async () => {
      let method = '';
      let path = '';
      let authHeader: string | undefined;
      let body = '';
      const srv = await serve((req, res) => {
        method = req.method ?? '';
        path = req.url ?? '';
        authHeader = req.headers.authorization;
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ deployments: [{ resource_uuid: 'app-123' }] }));
        });
      });
      try {
        await expect(
          factory.create(timeoutMs).deployApp(base(srv.url), 'app-123'),
        ).resolves.toBeUndefined();
        expect(method).toBe('POST');
        expect(path).toBe('/api/v1/deploy');
        expect(authHeader).toBe('Bearer tok-deploy');
        expect(JSON.parse(body)).toEqual({ uuid: 'app-123', force: true });
      } finally {
        await srv.close();
      }
    });

    it('deployApp rejects on a non-2xx response', async () => {
      const srv = await serve((_req, res) => {
        res.writeHead(500);
        res.end('boom');
      });
      try {
        await expect(
          factory.create(timeoutMs).deployApp(base(srv.url), 'app-123'),
        ).rejects.toThrow(/500/);
      } finally {
        await srv.close();
      }
    });

    it('deploymentStatus GETs the application and returns its raw status', async () => {
      let path = '';
      let authHeader: string | undefined;
      const srv = await serve((req, res) => {
        path = req.url ?? '';
        authHeader = req.headers.authorization;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ uuid: 'app-123', status: 'in_progress' }));
      });
      try {
        const out = await factory.create(timeoutMs).deploymentStatus(base(srv.url), 'app-123');
        expect(out.rawStatus).toBe('in_progress');
        expect(out.detail).toBeUndefined();
        expect(path).toBe('/api/v1/applications/app-123');
        expect(authHeader).toBe('Bearer tok-deploy');
      } finally {
        await srv.close();
      }
    });

    it('deploymentStatus degrades to unknown (never rejects) on a non-200', async () => {
      const srv = await serve((_req, res) => {
        res.writeHead(503);
        res.end('unavailable');
      });
      try {
        const out = await factory.create(timeoutMs).deploymentStatus(base(srv.url), 'app-123');
        expect(out.rawStatus).toBe('unknown');
        expect(out.detail).toContain('503');
      } finally {
        await srv.close();
      }
    });

    it('applyAppLimits PATCHes limits_cpus + limits_memory on /applications/{uuid}', async () => {
      let method = '';
      let path = '';
      let authHeader: string | undefined;
      let body = '';
      const srv = await serve((req, res) => {
        method = req.method ?? '';
        path = req.url ?? '';
        authHeader = req.headers.authorization;
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      try {
        await expect(
          factory.create(timeoutMs).applyAppLimits(base(srv.url), 'app-123', {
            cpus: '1',
            memory: '1g',
          }),
        ).resolves.toBeUndefined();
        expect(method).toBe('PATCH');
        expect(path).toBe('/api/v1/applications/app-123');
        expect(authHeader).toBe('Bearer tok-deploy');
        const parsed = JSON.parse(body) as Record<string, string>;
        expect(parsed.limits_cpus).toBe('1');
        expect(parsed.limits_memory).toBe('1g');
      } finally {
        await srv.close();
      }
    });

    it('applyAppLimits sends nothing and resolves when no limit is provided', async () => {
      const srv = await serve((_req, res) => {
        res.writeHead(200);
        res.end();
      });
      try {
        await expect(
          factory.create(timeoutMs).applyAppLimits(base(srv.url), 'app-123', {}),
        ).resolves.toBeUndefined();
      } finally {
        await srv.close();
      }
    });

    it('applyAppLimits rejects on a non-2xx response', async () => {
      const srv = await serve((_req, res) => {
        res.writeHead(400);
        res.end('bad request');
      });
      try {
        await expect(
          factory.create(timeoutMs).applyAppLimits(base(srv.url), 'app-123', { memory: '512m' }),
        ).rejects.toThrow(/400/);
      } finally {
        await srv.close();
      }
    });

    it('refuses deploy ops on a non-Coolify provider (Hestia)', async () => {
      const hestiaTarget = { ...target, provider: 'HESTIA' as const, baseUrl: 'http://127.0.0.1:1/api/' };
      await expect(
        factory.create(timeoutMs).createGitApp(hestiaTarget, {
          repoUrl: 'https://github.com/o/r.git',
          branch: 'main',
          serviceName: 'x',
        }),
      ).rejects.toThrow(/Coolify uniquement/);
      await expect(factory.create(timeoutMs).deployApp(hestiaTarget, 'x')).rejects.toThrow(/Coolify uniquement/);
      await expect(factory.create(timeoutMs).deploymentStatus(hestiaTarget, 'x')).rejects.toThrow(/Coolify uniquement/);
      await expect(
        factory.create(timeoutMs).applyAppLimits(hestiaTarget, 'x', { memory: '512m' }),
      ).rejects.toThrow(/Coolify uniquement/);
    });
  });
});
