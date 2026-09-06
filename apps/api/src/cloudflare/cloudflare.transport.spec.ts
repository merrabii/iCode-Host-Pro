// Phase 3 — tests du transport RÉEL Cloudflare v4 contre un simulateur loopback
// (aucun réseau externe) : header Bearer, chemins/query, enveloppe { success,
// result, errors } validée (success:false → erreur lisible), 401 clair.
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { CloudflareTransport } from './cloudflare.transport';

describe('CloudflareTransport', () => {
  const transport = new CloudflareTransport(2_000);
  const base = (url: string) => ({ token: 'cf-token', baseUrl: `${url}/client/v4`, strictTls: true });

  /** Démarre un mini-serveur HTTP qui répond selon `handler`. */
  function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
    const server = http.createServer(handler);
    return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((d) => server.close(() => d())) });
      });
    });
  }

  it('listZones GETs /zones?per_page=100 with Bearer and returns the zones array', async () => {
    let authHeader: string | undefined;
    let path = '';
    const srv = await serve((req, res) => {
      authHeader = req.headers.authorization;
      path = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: [{ id: 'z1', name: 'arumdigital.com', status: 'active', paused: false }] }));
    });
    try {
      const zones = await transport.listZones(base(srv.url));
      expect(zones).toEqual([{ id: 'z1', name: 'arumdigital.com', status: 'active', paused: false }]);
      expect(path).toContain('/zones?per_page=100');
      expect(authHeader).toBe('Bearer cf-token');
    } finally {
      await srv.close();
    }
  });

  it('listRecords GETs /zones/{id}/dns_records?per_page=100', async () => {
    let path = '';
    const srv = await serve((req, res) => {
      path = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: [{ id: 'r1', type: 'CNAME', name: 'monapp.arumdigital.com', content: 'panel.arumdigital.com', proxied: true, ttl: 1 }] }));
    });
    try {
      const records = await transport.listRecords(base(srv.url), 'z1');
      expect(records[0].type).toBe('CNAME');
      expect(path).toContain('/zones/z1/dns_records?per_page=100');
    } finally {
      await srv.close();
    }
  });

  it('findRecordByName filters by name (disponibilité sous-domaine)', async () => {
    let path = '';
    const srv = await serve((req, res) => {
      path = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: [] }));
    });
    try {
      const found = await transport.findRecordByName(base(srv.url), 'z1', 'monapp.arumdigital.com');
      expect(found).toBeNull();
      expect(path).toContain('/zones/z1/dns_records?name=monapp.arumdigital.com');
    } finally {
      await srv.close();
    }
  });

  it('createRecord POSTs /zones/{id}/dns_records and returns the new record id', async () => {
    let method = '';
    let path = '';
    let body = '';
    let authHeader: string | undefined;
    const srv = await serve((req, res) => {
      method = req.method ?? '';
      path = req.url ?? '';
      authHeader = req.headers.authorization;
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result: { id: 'nr-42' } }));
      });
    });
    try {
      const id = await transport.createRecord(base(srv.url), 'z1', {
        type: 'CNAME',
        name: 'monapp.arumdigital.com',
        content: 'panel.arumdigital.com',
        proxied: true,
        ttl: 1,
      });
      expect(id).toBe('nr-42');
      expect(method).toBe('POST');
      expect(path).toBe('/client/v4/zones/z1/dns_records');
      expect(authHeader).toBe('Bearer cf-token');
      const sent = JSON.parse(body) as Record<string, unknown>;
      expect(sent.type).toBe('CNAME');
      expect(sent.proxied).toBe(true);
      expect(sent.ttl).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('deleteRecord DELETEs the record path and resolves on success', async () => {
    let method = '';
    let path = '';
    const srv = await serve((req, res) => {
      method = req.method ?? '';
      path = req.url ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { id: 'r1' } }));
    });
    try {
      await expect(transport.deleteRecord(base(srv.url), 'z1', 'r1')).resolves.toBeUndefined();
      expect(method).toBe('DELETE');
      expect(path).toBe('/client/v4/zones/z1/dns_records/r1');
    } finally {
      await srv.close();
    }
  });

  it('rejects with a clear 401 message when the token is rejected', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, errors: [{ code: 9109, message: 'Invalid API key' }] }));
    });
    try {
      await expect(transport.listZones(base(srv.url))).rejects.toThrow(/401/);
    } finally {
      await srv.close();
    }
  });

  it('rejects with a readable message when success=false (règle DNS violée)', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, errors: [{ code: 81057, message: 'DNS record not valid' }] }));
    });
    try {
      await expect(transport.createRecord(base(srv.url), 'z1', { type: 'CNAME', name: 'x', content: 'y' })).rejects.toThrow(
        /DNS record not valid/,
      );
    } finally {
      await srv.close();
    }
  });

  it('reports a refused connection clearly (aucune dépendance réseau en test)', async () => {
    const srv = await serve((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const closed = `${srv.url}/client/v4`;
    await srv.close();
    await expect(transport.listZones({ token: 'x', baseUrl: closed })).rejects.toThrow(/Connexion refusée/);
  });
});