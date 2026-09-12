// Sonde réelle temporaire : état du conteneur Coolify pour l'app de validation.
// Lit le Server Coolify en DB, décrypte le token, puis interroge l'API.
const { PrismaClient } = require('@prisma/client');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

const envRaw = fs.readFileSync('.env', 'utf8');
function envVal(k) {
  const m = envRaw.match(new RegExp(`^${k}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
}

const DATABASE_URL = envVal('DATABASE_URL');

process.env.DATABASE_URL = DATABASE_URL;
process.env.DOTENV_CONFIG_PATH = '.env';

function key() {
  const secret = envVal('ENCRYPTION_KEY');
  if (!secret) throw new Error('ENCRYPTION_KEY manquante');
  return crypto.createHash('sha256').update(secret).digest();
}
function decrypt(payload) {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

function httpJson(method, url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const prisma = new PrismaClient();
  const server = await prisma.server.findFirst({ where: { panelProvider: 'COOLIFY' } });
  if (!server) throw new Error('Aucun serveur Coolify');
  const token = decrypt(server.apiTokenEnc);
  const base = server.apiBaseUrl.replace(/\/+$/, '');
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };

  const uuid = 'p61av0qdtiqk0oyqakif3pmy';
  console.log('== App ==', uuid);
  const app = await httpJson('GET', `${base}/applications/${uuid}`, H);
  let appJson = {};
  try { appJson = JSON.parse(app.body); } catch {}
  console.log('HTTP', app.status);
  ['uuid','name','status','fqdn','ports_mappings','custom_docker_run_options','build_pack','base_directory',
    'base_directories','build_command','install_command','static_publish_directory','publis_directory',
    'publish_directory','is_static','docker_compose_domains','internal_domain'].forEach((k) => {
    if (appJson[k] !== undefined) console.log(`  ${k}:`, JSON.stringify(appJson[k]));
  });
  if (appJson.status) console.log('  (coolify status obj):', JSON.stringify(appJson.status));

  // Conteneurs exposés
  const cont = await httpJson('GET', `${base}/applications/${uuid}/containers`, H);
  console.log('\n== Containers, HTTP', cont.status);
  console.log(cont.body.slice(0, 3000));
  await prisma.$disconnect();
})().catch((e) => { console.error('ERREUR', e.message); process.exit(1); });