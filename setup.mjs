// Helper for the one-time Meta setup. Works on every token in PAGE_ACCESS_TOKENS.
//   node --env-file=.env setup.mjs check       → shows each Page, its linked IG account and webhook subscriptions
//   node --env-file=.env setup.mjs subscribe   → subscribes each Page to this app's webhooks (feed + messages)

const { GRAPH_VERSION = 'v23.0' } = process.env;
const tokens = `${process.env.PAGE_ACCESS_TOKENS || ''} ${process.env.PAGE_ACCESS_TOKEN || ''}`.split(/[\s,]+/).filter(Boolean);
if (!tokens.length) { console.error('Fill PAGE_ACCESS_TOKENS in .env first'); process.exit(1); }

const base = `https://graph.facebook.com/${GRAPH_VERSION}`;
async function call(token, method, pathname, params = {}) {
  const q = new URLSearchParams({ ...params, access_token: token });
  const json = await (await fetch(`${base}/${pathname}?${q}`, { method })).json();
  if (json.error) throw new Error(`${pathname}: ${json.error.message}`);
  return json;
}

const cmd = process.argv[2];
if (cmd !== 'check' && cmd !== 'subscribe') {
  console.log('Usage: node --env-file=.env setup.mjs check|subscribe');
  process.exit(1);
}
let failed = false;
for (const token of tokens) {
  try {
    const page = await call(token, 'GET', 'me', { fields: 'id,name,instagram_business_account{id,username}' });
    const ig = page.instagram_business_account;
    console.log(`\nPage: ${page.name} (${page.id}) · Instagram: ${ig ? `@${ig.username}` : 'NOT linked'}`);
    if (cmd === 'subscribe') {
      const r = await call(token, 'POST', `${page.id}/subscribed_apps`, { subscribed_fields: 'feed,messages' });
      console.log(r.success ? '  subscribed to feed + messages ✔' : r);
    } else {
      const subs = await call(token, 'GET', `${page.id}/subscribed_apps`);
      console.log('  subscribed apps:', JSON.stringify(subs.data));
    }
  } catch (e) { failed = true; console.error(`  token …${token.slice(-6)} failed: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
