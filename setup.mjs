// Helper for the one-time Meta setup.
//   node --env-file=.env setup.mjs check       → confirms token, Page, linked IG account
//   node --env-file=.env setup.mjs subscribe   → subscribes the Page to this app's webhooks

const { PAGE_ACCESS_TOKEN, PAGE_ID, GRAPH_VERSION = 'v23.0' } = process.env;
if (!PAGE_ACCESS_TOKEN || !PAGE_ID) { console.error('Fill PAGE_ACCESS_TOKEN and PAGE_ID in .env first'); process.exit(1); }

const base = `https://graph.facebook.com/${GRAPH_VERSION}`;
async function call(method, pathname, params = {}) {
  const q = new URLSearchParams({ ...params, access_token: PAGE_ACCESS_TOKEN });
  const res = await fetch(`${base}/${pathname}?${q}`, { method });
  const json = await res.json();
  if (json.error) throw new Error(`${pathname}: ${json.error.message}`);
  return json;
}

const cmd = process.argv[2];
try {
  if (cmd === 'check') {
    const page = await call('GET', PAGE_ID, { fields: 'id,name,instagram_business_account{id,username}' });
    console.log(`Page: ${page.name} (${page.id})`);
    const ig = page.instagram_business_account;
    console.log(ig ? `Instagram: @${ig.username} — put IG_USER_ID=${ig.id} in .env` : 'Instagram: NOT linked to this Page');
    const subs = await call('GET', `${PAGE_ID}/subscribed_apps`);
    console.log('Subscribed apps:', JSON.stringify(subs.data));
  } else if (cmd === 'subscribe') {
    const r = await call('POST', `${PAGE_ID}/subscribed_apps`, { subscribed_fields: 'feed,messages' });
    console.log(r.success ? 'Page subscribed to feed + messages ✔' : r);
  } else {
    console.log('Usage: node --env-file=.env setup.mjs check|subscribe');
  }
} catch (e) { console.error(e.message); process.exit(1); }
