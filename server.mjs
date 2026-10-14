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
  GRAPH_VERSION = 'v23.0',
  DRY_RUN = '',
  KEYWORDS_FILE = path.join(HERE, 'keywords.json'),
} = process.env;

const dryRun = DRY_RUN === '1' || DRY_RUN === 'true';
if (!VERIFY_TOKEN && !dryRun) { console.error('Missing VERIFY_TOKEN'); process.exit(1); }
// The rest can arrive later (e.g. after the webhook is verified). Until then:
// no APP_SECRET → every POST is rejected; no Page tokens → events are ignored.
if (!APP_SECRET && !dryRun) console.warn('[setup] APP_SECRET not set yet');

// ---------- accounts: one per Page token (+ the IG account linked to that Page) ----------
// PAGE_ACCESS_TOKENS: one or more Page tokens, separated by commas, spaces or new lines.
// PAGE_ACCESS_TOKEN (single) still works. Page and IG IDs are looked up from each token.

const tokens = `${process.env.PAGE_ACCESS_TOKENS || ''} ${process.env.PAGE_ACCESS_TOKEN || ''}`
  .split(/[\s,]+/).filter(Boolean);
const accounts = [];                 // { token, pageId, pageName, igId, igUsername }
const accountById = new Map();       // pageId or igId → account

function addAccount(a) {
  accounts.push(a);
  if (a.pageId) accountById.set(a.pageId, a);
  if (a.igId) accountById.set(a.igId, a);
}

async function loadAccounts() {
  if (dryRun) {
    // Fake accounts for local tests, e.g. DRY_RUN_ACCOUNTS='[{"pageId":"P1","igId":"IG1"}]'
    for (const a of JSON.parse(process.env.DRY_RUN_ACCOUNTS || '[]')) addAccount(a);
    return;
  }
  if (!tokens.length) { console.warn('[setup] PAGE_ACCESS_TOKENS not set yet'); return; }
  for (const token of tokens) {
    try {
      const q = new URLSearchParams({ fields: 'id,name,instagram_business_account{id,username}', access_token: token });
      const me = await (await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/me?${q}`)).json();
      if (me.error) throw new Error(me.error.message);
      const ig = me.instagram_business_account;
      addAccount({ token, pageId: me.id, pageName: me.name, igId: ig?.id, igUsername: ig?.username });
      console.log(`[setup] Page: ${me.name} (${me.id}) · Instagram: ${ig ? `@${ig.username} (${ig.id})` : 'not linked'}`);
    } catch (e) {
      console.warn(`[setup] Page lookup failed for token …${token.slice(-6)} (${e.message.slice(0, 90)}…), trying debug_token`);
      await addAccountFromDebugToken(token);
    }
  }
}

// Fallback when the Page token can't read its own Page (e.g. pages_read_engagement not granted):
// debug_token, called with the app token, still tells us the Page ID, linked IG IDs and granted scopes.
async function addAccountFromDebugToken(token) {
  const { APP_ID } = process.env;
  if (!APP_ID || !APP_SECRET) { console.error('[setup] set APP_ID and APP_SECRET to use the debug_token fallback'); return; }
  try {
    const q = new URLSearchParams({ input_token: token, access_token: `${APP_ID}|${APP_SECRET}` });
    const { data, error } = await (await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token?${q}`)).json();
    if (error) throw new Error(error.message);
    if (!data?.is_valid) throw new Error(`token not valid${data?.error?.message ? `: ${data.error.message}` : ''}`);
    const pageId = data.profile_id;
    const igIds = (data.granular_scopes || []).filter(s => s.scope.startsWith('instagram_')).flatMap(s => s.target_ids || []);
    const igId = [...new Set(igIds)].length === 1 ? igIds[0] : undefined;
    addAccount({ token, pageId, igId });
    console.log(`[setup] Page ${pageId} · Instagram: ${igId || (igIds.length ? `ambiguous (${[...new Set(igIds)].join(', ')})` : 'none granted')}`);
    console.log(`[setup]   scopes on this token: ${(data.scopes || []).join(', ')}`);
  } catch (e) {
    console.error(`[setup] debug_token failed for token …${token.slice(-6)}: ${e.message}`);
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

// rule.accounts (optional): Page names, Page IDs, IG usernames or IG IDs the rule is limited to.
const ruleFitsAccount = (r, acct) => !r.accounts?.length || r.accounts.map(norm).some(x =>
  [acct.pageId, acct.pageName, acct.igId, acct.igUsername].filter(Boolean).map(norm).includes(x));

// trigger: 'comment' | 'dm'; platform: 'facebook' | 'instagram'; postId optional
function findRule(text, { trigger, platform, postId, acct }) {
  const t = norm(text);
  if (!t) return null;
  return rules.find(r => {
    if (r.triggers && !r.triggers.includes(trigger)) return false;
    if (r.platforms && !r.platforms.includes(platform)) return false;
    if (!ruleFitsAccount(r, acct)) return false;
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

async function graph(acct, pathname, body) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pathname}`;
  if (dryRun) { console.log(`[dry-run] POST ${pathname} ${JSON.stringify(body)}`); return { dryRun: true }; }
  const res = await fetch(`${url}?access_token=${encodeURIComponent(acct.token)}`, {
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
const sendPrivateReply = (acct, commentId, text) =>
  graph(acct, `${acct.pageId}/messages`, { recipient: { comment_id: commentId }, message: { text } });

// Regular DM reply inside the 24h window the user opened by messaging you.
const sendDm = (acct, userId, text) =>
  graph(acct, `${acct.pageId}/messages`, { recipient: { id: userId }, messaging_type: 'RESPONSE', message: { text } });

// Optional public reply under the comment ("Sent! Check your DMs").
const publicReply = (acct, platform, commentId, text) =>
  platform === 'instagram'
    ? graph(acct, `${commentId}/replies`, { message: text })
    : graph(acct, `${commentId}/comments`, { message: text });

// ---------- event handlers ----------

const isOwnAccount = id => Boolean(id && accountById.has(id)); // our own replies/echoes on any account
const label = (acct, platform) => platform === 'instagram' ? `@${acct.igUsername || acct.igId}` : (acct.pageName || acct.pageId);

async function onComment({ acct, platform, commentId, text, fromId, username, postId }) {
  if (isOwnAccount(fromId)) return;
  const rule = findRule(text, { trigger: 'comment', platform, postId, acct });
  if (!rule || !once(`c:${commentId}`, 7 * DAY)) return;
  const msg = fill(rule.message, { link: rule.link, name: username || 'friend' });
  console.log(`[${label(acct, platform)}] comment "${text}" by ${username || fromId} → rule ${rule.keyword}`);
  await sendPrivateReply(acct, commentId, msg);
  if (rule.publicReply) await publicReply(acct, platform, commentId, fill(rule.publicReply, { name: username || '' }))
    .catch(e => console.error(`[${label(acct, platform)}] public reply failed: ${e.message}`));
}

async function onMessage({ acct, platform, senderId, text }) {
  const rule = findRule(text, { trigger: 'dm', platform, acct });
  if (!rule) return;
  if (!once(`d:${acct.pageId}:${senderId}:${rule.keyword}`, (rule.cooldownMinutes ?? 10) * 60_000)) return;
  console.log(`[${label(acct, platform)}] DM "${text}" from ${senderId} → rule ${rule.keyword}`);
  await sendDm(acct, senderId, fill(rule.message, { link: rule.link, name: 'friend' }));
}

function dispatch(payload) {
  const jobs = [];
  const platform = payload.object === 'instagram' ? 'instagram' : 'facebook';
  if (payload.object !== 'page' && payload.object !== 'instagram') return jobs;

  for (const entry of payload.entry || []) {
    // entry.id is the Page ID (Facebook) or the IG account ID (Instagram) the event belongs to.
    const acct = accountById.get(entry.id);
    if (!acct) { console.warn(`[webhook] event for unknown account ${entry.id}, no token for it, ignored`); continue; }
    // DMs (Messenger + Instagram Direct)
    for (const ev of entry.messaging || []) {
      const m = ev.message;
      if (!m || m.is_echo || !m.text || isOwnAccount(ev.sender?.id)) continue;
      jobs.push(onMessage({ acct, platform, senderId: ev.sender.id, text: m.text }));
    }
    // Comments
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (platform === 'facebook' && ch.field === 'feed' && v.item === 'comment' && v.verb === 'add') {
        jobs.push(onComment({ acct, platform, commentId: v.comment_id, text: v.message, fromId: v.from?.id, username: v.from?.name, postId: v.post_id }));
      }
      if (platform === 'instagram' && ch.field === 'comments') {
        jobs.push(onComment({ acct, platform, commentId: v.id, text: v.text, fromId: v.from?.id, username: v.from?.username, postId: v.media?.id }));
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
  loadAccounts();
}
