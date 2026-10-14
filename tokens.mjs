// Turns one short-lived user token (from Graph API Explorer) into never-expiring Page tokens
// for the Pages you name, and copies them to the clipboard as one comma-separated line
// ready to paste into Render's PAGE_ACCESS_TOKENS. Nothing secret is printed.
//
//   node tokens.mjs "First Off In My Opinion" "Tom Swoope Events" "Taking Care Of Family"

import { execFileSync } from 'node:child_process';

const APP_ID = process.env.APP_ID || '1146180881120023';
const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v23.0'}`;
const wanted = process.argv.slice(2);
if (!wanted.length) { console.error('Name the Pages, e.g. node tokens.mjs "My Page" "Other Page"'); process.exit(1); }

// Read a line without echoing it to the screen.
function askHidden(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    const { stdin } = process;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let value = '';
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write(' ✔\n'); return resolve(value.trim()); }
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function get(pathname, params) {
  const json = await (await fetch(`${GRAPH}/${pathname}?${new URLSearchParams(params)}`)).json();
  if (json.error) throw new Error(json.error.message);
  return json;
}

const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

try {
  const appSecret = process.env.APP_SECRET || await askHidden('Paste the App secret, then press Return: ');
  const shortToken = await askHidden('Paste the Graph API Explorer token, then press Return: ');

  // 1. Short-lived user token → 60-day user token. Page tokens fetched with it never expire.
  const { access_token: longToken } = await get('oauth/access_token', {
    grant_type: 'fb_exchange_token', client_id: APP_ID, client_secret: appSecret, fb_exchange_token: shortToken,
  });

  // 2. List the Pages this user manages, with their Page tokens.
  let pages = [], url = 'me/accounts', params = { fields: 'id,name,access_token,instagram_business_account{username}', limit: '100', access_token: longToken };
  while (url) {
    const res = await get(url, params);
    pages.push(...res.data);
    url = res.paging?.next ? res.paging.next.replace(`${GRAPH}/`, '').split('?')[0] : null;
    if (url) params = Object.fromEntries(new URL(res.paging.next).searchParams);
  }

  const picked = [];
  for (const name of wanted) {
    const p = pages.find(p => p.id === name || norm(p.name) === norm(name));
    if (!p) { console.error(`✘ No Page called "${name}" in this login. Pages found: ${pages.map(p => p.name).join(', ')}`); process.exit(1); }
    picked.push(p);
  }

  // 3. Check each Page token: expiry and permissions.
  for (const p of picked) {
    const { data } = await get('debug_token', { input_token: p.access_token, access_token: `${APP_ID}|${appSecret}` });
    const ig = p.instagram_business_account ? `@${p.instagram_business_account.username}` : 'no Instagram linked';
    const expires = data.expires_at === 0 ? 'never expires' : `expires ${new Date(data.expires_at * 1000).toLocaleDateString()}`;
    console.log(`✔ ${p.name} · ${ig} · ${expires}`);
    console.log(`    permissions: ${(data.scopes || []).join(', ')}`);
  }

  execFileSync('pbcopy', { input: picked.map(p => p.access_token).join(',') });
  console.log(`\n📋 Copied ${picked.length} Page tokens to your clipboard.`);
  console.log('   Paste them into Render → Environment → PAGE_ACCESS_TOKENS (replace the old value), then Save, rebuild, and deploy.');
} catch (e) {
  console.error(`\n✘ ${e.message}`);
  process.exit(1);
}
