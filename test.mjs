// Local test: starts the server in DRY_RUN mode and fires fake signed Meta webhooks at it.
//   node test.mjs

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3999, SECRET = 'test-secret';
const kwFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dmbot-')), 'keywords.json');
fs.writeFileSync(kwFile, JSON.stringify({ rules: [
  { keyword: 'GUIDE', match: 'contains', link: 'https://example.com/guide', message: 'Hi {name} {link}', publicReply: 'Check DMs', triggers: ['comment', 'dm'] },
  { keyword: 'VIP', match: 'exact', link: 'https://example.com/vip', message: '{link}', triggers: ['dm'], platforms: ['instagram'] },
  { keyword: 'PROMO', match: 'contains', link: 'https://example.com/p', message: '{link}', triggers: ['comment'], postIds: ['media_1'] },
] }));

const proc = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
  env: { ...process.env, PORT, DRY_RUN: '1', APP_SECRET: SECRET, VERIFY_TOKEN: 'vt', PAGE_ID: 'PAGE', IG_USER_ID: 'IGME', KEYWORDS_FILE: kwFile },
});
let out = '';
proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => out += d);
await new Promise(r => setTimeout(r, 600));

const url = `http://localhost:${PORT}/webhook`;
const post = (body, secret = SECRET) => {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return fetch(url, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
};
const settle = () => new Promise(r => setTimeout(r, 150));
const results = [];
async function check(name, fn, expect) {
  const before = out.length;
  const status = await fn(); await settle();
  const log = out.slice(before);
  const ok = expect(log, status);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      status=${status}\n      log=${log.trim()}`}`);
}
const fbComment = (id, msg, from = 'u1') => ({ object: 'page', entry: [{ changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: id, post_id: 'p1', message: msg, from: { id: from, name: 'Ana' } } }] }] });
const igComment = (id, text, media = 'media_9', from = 'u2') => ({ object: 'instagram', entry: [{ changes: [{ field: 'comments', value: { id, text, media: { id: media }, from: { id: from, username: 'bo' } } }] }] });
const dm = (object, sender, text, extra = {}) => ({ object, entry: [{ messaging: [{ sender: { id: sender }, message: { text, ...extra } }] }] });

await check('verify handshake', async () => (await fetch(`${url}?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`)).text(), (_, s) => s === '42');
await check('verify rejects bad token', async () => (await fetch(`${url}?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42`)).status, (_, s) => s === 403);
await check('bad signature rejected', async () => (await post(fbComment('c0', 'guide'), 'wrong')).status, (log, s) => s === 401 && !log.includes('dry-run'));
await check('FB comment "guide please!" → private reply + public reply', async () => (await post(fbComment('c1', 'Guide please!'))).status,
  log => log.includes('"comment_id":"c1"') && log.includes('Hi Ana https://example.com/guide') && log.includes('c1/comments'));
await check('same comment again → ignored (dedupe)', async () => (await post(fbComment('c1', 'Guide please!'))).status, log => !log.includes('dry-run'));
await check('IG comment "GUIDE" → private reply + IG public reply', async () => (await post(igComment('ic1', 'GUIDE 🙏'))).status,
  log => log.includes('"comment_id":"ic1"') && log.includes('ic1/replies'));
await check('"guidebook" does not match "guide"', async () => (await post(igComment('ic2', 'love the guidebook'))).status, log => !log.includes('dry-run'));
await check('own IG reply ignored', async () => (await post(igComment('ic3', 'guide', 'media_9', 'IGME'))).status, log => !log.includes('dry-run'));
await check('PROMO only on its post', async () => (await post(igComment('ic4', 'promo', 'media_2'))).status, log => !log.includes('dry-run'));
await check('PROMO on media_1 → sent', async () => (await post(igComment('ic5', 'promo', 'media_1'))).status, log => log.includes('"comment_id":"ic5"'));
await check('FB DM "guide" → DM reply', async () => (await post(dm('page', 'u5', 'guide'))).status, log => log.includes('"recipient":{"id":"u5"}'));
await check('FB DM "guide" again → cooldown', async () => (await post(dm('page', 'u5', 'guide'))).status, log => !log.includes('dry-run'));
await check('IG DM "vip" exact → reply', async () => (await post(dm('instagram', 'u6', 'VIP'))).status, log => log.includes('example.com/vip'));
await check('FB DM "vip" → no reply (IG-only rule)', async () => (await post(dm('page', 'u7', 'vip'))).status, log => !log.includes('dry-run'));
await check('IG DM "vip pass" → no reply (exact match)', async () => (await post(dm('instagram', 'u8', 'vip pass'))).status, log => !log.includes('dry-run'));
await check('echo of our own message ignored', async () => (await post(dm('page', 'u9', 'guide', { is_echo: true }))).status, log => !log.includes('dry-run'));

proc.kill();
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
