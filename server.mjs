// Keyword → DM automation for Facebook Pages and Instagram (Meta Graph API webhooks).
// Zero dependencies. Run: node --env-file=.env server.mjs
//
// Triggers:
//   - Someone comments a keyword on a FB Page post or IG post/reel → private-reply DM with the link
//   - Someone DMs a keyword to the FB Page or IG account → DM reply with the link

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const {
  PORT = 3000,
  VERIFY_TOKEN,
  APP_SECRET,
  PAGE_ACCESS_TOKEN,
  GRAPH_VERSION = 'v23.0',
  DRY_RUN = '',
  KEYWORDS_FILE = path.join(HERE, 'keywords.json'),
} = process.env;
// Optional: looked up from the Page token at startup when not set.
let { PAGE_ID, IG_USER_ID } = process.env;

const dryRun = DRY_RUN === '1' || DRY_RUN === 'true';
if (!VERIFY_TOKEN && !dryRun) { console.error('Missing VERIFY_TOKEN'); process.exit(1); }
// The rest can arrive later (e.g. after the webhook is verified). Until then:
// no APP_SECRET → every POST is rejected; no token/page → events are logged, nothing is sent.
const canSend = () => Boolean(PAGE_ACCESS_TOKEN && PAGE_ID);
for (const [k, v] of Object.entries({ APP_SECRET, PAGE_ACCESS_TOKEN })) {
  if (!v && !dryRun) console.warn(`[setup] ${k} not set yet`);
}

async function discoverIds() {
  if (dryRun || !PAGE_ACCESS_TOKEN || (PAGE_ID && IG_USER_ID)) return;
  try {
    const q = new URLSearchParams({ fields: 'id,name,instagram_business_account{id,username}', access_token: PAGE_ACCESS_TOKEN });
    const me = await (await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/me?${q}`)).json();
    if (me.error) throw new Error(me.error.message);
    PAGE_ID ||= me.id;
    IG_USER_ID ||= me.instagram_business_account?.id;
    const ig = me.instagram_business_account;
    console.log(`[setup] Page: ${me.name} (${PAGE_ID}) · Instagram: ${ig ? `@${ig.username} (${IG_USER_ID})` : 'not linked'}`);
  } catch (e) {
    console.error(`[setup] could not look up Page/IG from token: ${e.message}`);
  }
}

// ---------- keyword rules (re-read on change, no restart needed) ----------

let rules = [];
function loadRules() {
  try {
    rules = JSON.parse(fs.readFileSync(KEYWORDS_FILE, 'utf8')).rules.filter(r => r.enabled !== false);
    console.log(`[rules] loaded ${rules.length} rule(s): ${rules.map(r => r.keyword).join(', ')}`);
  } catch (e) {
    console.error(`[rules] could not load ${KEYWORDS_FILE}: ${e.message}`);
  }
}
loadRules();
fs.watchFile(KEYWORDS_FILE, { interval: 2000 }, loadRules);

const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// trigger: 'comment' | 'dm'; platform: 'facebook' | 'instagram'; postId optional
function findRule(text, { trigger, platform, postId }) {
  const t = norm(text);
  if (!t) return null;
  return rules.find(r => {
    if (r.triggers && !r.triggers.includes(trigger)) return false;
    if (r.platforms && !r.platforms.includes(platform)) return false;
    if (trigger === 'comment' && r.postIds?.length && !r.postIds.includes(postId)) return false;
    const kws = [r.keyword, ...(r.aliases || [])].map(norm);
    return kws.some(k => r.match === 'exact' ? t === k : ` ${t} `.includes(` ${k} `));
  }) || null;
}

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

// ---------- dedupe (one DM per comment; per user+rule cooldown for DMs) ----------

const seen = new Map();
function once(key, ttlMs) {
  const now = Date.now();
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  if (seen.has(key)) return false;
  seen.set(key, now + ttlMs);
  return true;
}
const DAY = 86_400_000;

// ---------- Graph API ----------

async function graph(pathname, body) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pathname}`;
  if (dryRun || !canSend()) { console.log(`[${dryRun ? 'dry-run' : 'not-sent: no token'}] POST ${pathname} ${JSON.stringify(body)}`); return { dryRun: true }; }
  const res = await fetch(`${url}?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pathname} → ${res.status} ${JSON.stringify(json.error || json)}`);
  return json;
}

// Private reply: a DM tied to a comment. Works for FB Page comments and IG comments
// (IG must be linked to the Page). Allowed once per comment, within 7 days.
const sendPrivateReply = (commentId, text) =>
  graph(`${PAGE_ID}/messages`, { recipient: { comment_id: commentId }, message: { text } });

// Regular DM reply inside the 24h window the user opened by messaging you.
const sendDm = (userId, text) =>
  graph(`${PAGE_ID}/messages`, { recipient: { id: userId }, messaging_type: 'RESPONSE', message: { text } });

// Optional public reply under the comment ("Sent! Check your DMs").
const publicReply = (platform, commentId, text) =>
  platform === 'instagram'
    ? graph(`${commentId}/replies`, { message: text })
    : graph(`${commentId}/comments`, { message: text });

// ---------- event handlers ----------

async function onComment({ platform, commentId, text, fromId, username, postId }) {
  if (fromId && (fromId === PAGE_ID || fromId === IG_USER_ID)) return; // our own replies
  const rule = findRule(text, { trigger: 'comment', platform, postId });
  if (!rule || !once(`c:${commentId}`, 7 * DAY)) return;
  const msg = fill(rule.message, { link: rule.link, name: username || 'friend' });
  console.log(`[${platform}] comment "${text}" by ${username || fromId} → rule ${rule.keyword}`);
  await sendPrivateReply(commentId, msg);
  if (rule.publicReply) await publicReply(platform, commentId, fill(rule.publicReply, { name: username || '' }))
    .catch(e => console.error(`[${platform}] public reply failed: ${e.message}`));
}

async function onMessage({ platform, senderId, text }) {
  const rule = findRule(text, { trigger: 'dm', platform });
  if (!rule) return;
  if (!once(`d:${senderId}:${rule.keyword}`, (rule.cooldownMinutes ?? 10) * 60_000)) return;
  console.log(`[${platform}] DM "${text}" from ${senderId} → rule ${rule.keyword}`);
  await sendDm(senderId, fill(rule.message, { link: rule.link, name: 'friend' }));
}

function dispatch(payload) {
  const jobs = [];
  const platform = payload.object === 'instagram' ? 'instagram' : 'facebook';
  if (payload.object !== 'page' && payload.object !== 'instagram') return jobs;

  for (const entry of payload.entry || []) {
    // DMs (Messenger + Instagram Direct)
    for (const ev of entry.messaging || []) {
      const m = ev.message;
      if (!m || m.is_echo || !m.text) continue;
      if (ev.sender?.id === PAGE_ID || ev.sender?.id === IG_USER_ID) continue;
      jobs.push(onMessage({ platform, senderId: ev.sender.id, text: m.text }));
    }
    // Comments
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (platform === 'facebook' && ch.field === 'feed' && v.item === 'comment' && v.verb === 'add') {
        jobs.push(onComment({ platform, commentId: v.comment_id, text: v.message, fromId: v.from?.id, username: v.from?.name, postId: v.post_id }));
      }
      if (platform === 'instagram' && ch.field === 'comments') {
        jobs.push(onComment({ platform, commentId: v.id, text: v.text, fromId: v.from?.id, username: v.from?.username, postId: v.media?.id }));
      }
    }
  }
  return jobs;
}

// ---------- HTTP ----------

function validSignature(raw, header) {
  if (dryRun && !APP_SECRET) return true;
  if (!APP_SECRET || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex'));
  const got = Buffer.from(header);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') { res.end('ok'); return; }

  if (req.method === 'GET' && url.pathname === '/webhook') {
    const q = url.searchParams;
    if (q.get('hub.mode') === 'subscribe' && q.get('hub.verify_token') === VERIFY_TOKEN) {
      res.end(q.get('hub.challenge'));
    } else { res.writeHead(403).end(); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/webhook') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      if (!validSignature(raw, req.headers['x-hub-signature-256'])) {
        console.warn('[webhook] bad signature, ignored');
        res.writeHead(401).end(); return;
      }
      res.writeHead(200).end('EVENT_RECEIVED'); // ack fast; Meta retries slow responses
      let payload;
      try { payload = JSON.parse(raw); } catch { return; }
      for (const r of await Promise.allSettled(dispatch(payload))) {
        if (r.status === 'rejected') console.error(`[send] ${r.reason.message}`);
      }
    });
    return;
  }

  res.writeHead(404).end();
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`DM bot listening on :${PORT}${dryRun ? ' (DRY RUN, nothing is sent)' : ''}`));
  discoverIds();
}
