# Keyword → DM automation (Facebook + Instagram)

People **comment** a keyword on your post or reel, or **DM** you the keyword, and they automatically get a DM with your link. It works on as many Facebook Pages as you give it tokens for, plus the Instagram account linked to each Page. Replies always go out from the account that was messaged.

- `keywords.json`: your keyword → link rules. Edit it any time; the server reloads it without a restart.
- `server.mjs`: the webhook server. It has zero dependencies, so there's no `npm install`.
- `setup.mjs`: one-time helpers (`check`, `subscribe`).
- `test.mjs`: a local test that fires fake Meta events and sends nothing (`npm test`).

## Editing keywords

```json
{
  "keyword": "GUIDE",
  "aliases": ["the guide"],
  "match": "contains",
  "link": "https://tomswoope.com/guide",
  "message": "Hey {name}! Here's the link 👇\n{link}",
  "publicReply": "Sent! Check your DMs 📩",
  "triggers": ["comment", "dm"],
  "platforms": ["facebook", "instagram"],
  "postIds": [],
  "enabled": true
}
```

| Field | What it does |
|---|---|
| `match` | `contains`: "guide please!" triggers it, but "guidebook" doesn't. `exact`: the whole comment must be just the keyword. |
| `{name}` / `{link}` | Filled in automatically. `{name}` is the commenter's name or username. |
| `publicReply` | Optional public reply under the comment. Leave it out for silent DMs. Replying publicly boosts the post's engagement. |
| `postIds` | Optional. Limits the rule to specific posts (FB post ID or IG media ID). Leave it empty for all posts. |
| `accounts` | Optional. Limits the rule to certain Pages or IG accounts by Page name, IG username or ID, e.g. `["Tom Swoope Events"]`. Leave it empty to use the rule on every account. |
| `triggers` / `platforms` | Optional. Limits where the rule fires. |
| `cooldownMinutes` | Stops repeat DM replies to the same person (default 10). Each comment only ever gets one DM. |

Case, punctuation and emoji are ignored.

## One-time setup (about 30 min)

### 1. Accounts
- Instagram must be a **Professional (Business or Creator)** account **linked to your Facebook Page**.
- In the Instagram app, go to Settings → Messages and story replies → Message controls → Connected tools and turn on **Allow access to messages**.

### 2. Create the Meta app
1. Go to https://developers.facebook.com/apps and click **Create app**. Choose the **Business** type (or the "Other" use case → Business).
2. Add the **Messenger** product and the **Instagram** product (the *API setup with Facebook login* option).
3. Under **App settings → Basic**, copy the **App secret** into `.env` as `APP_SECRET`.

### 3. Host the server (it needs a public HTTPS URL)
The easiest free option is **Render.com**:
1. Put this `dm-automation` folder in a GitHub repo.
2. On Render, create a **New Web Service** from that repo. Build command: none. Start command: `npm start`.
3. Add `APP_SECRET` and `PAGE_ACCESS_TOKENS` as Environment Variables. `render.yaml` sets up the rest, and `VERIFY_TOKEN` is generated for you.
4. Your webhook URL is `https://<your-app>.onrender.com/webhook`.

Render's free tier sleeps after about 15 minutes idle. The first event after a nap can take around 30 seconds and Meta retries it, so it still works. If you want instant replies, use the $7/mo plan, or ping `/` every 10 minutes with a free uptime monitor.

### 4. Get a Page access token
1. Open Graph API Explorer (https://developers.facebook.com/tools/explorer). Select your app, then **User token**, and add these permissions:
   `pages_show_list, pages_messaging, pages_manage_metadata, pages_read_engagement, pages_manage_engagement, instagram_basic, instagram_manage_messages, instagram_manage_comments, business_management`
2. Click **Generate Access Token** and approve it for your Page and IG account.
   The easier route is the Meta app dashboard: go to **Use cases → Messenger → Customize → Messenger API Settings → Generate access tokens**, click **Generate** next to each Page, and copy the token.
3. Put every Page token in `PAGE_ACCESS_TOKENS`, separated by commas. The bot looks up each Page's ID and its linked Instagram account by itself, and the Render log lists every account it found at startup.

### 5. Connect the webhooks
1. In the app dashboard, go to **Messenger → Settings → Webhooks**. Callback URL: `https://<your-app>.onrender.com/webhook`. Verify token: your `VERIFY_TOKEN`. Subscribe to **messages** and **feed**.
2. Go to **Instagram → Webhooks** and enter the same URL and token. Subscribe to **comments** and **messages**.
3. In **Messenger API Settings → Generate access tokens**, click **Add subscriptions** next to each Page and tick **messages** and **feed**.

### 6. Test it
Comment your keyword on one of your posts from a **different** account (the bot ignores your own comments), or DM the keyword. Watch Render's logs.

### 7. Go live for everyone (App Review)
While the app is in **Development mode**, it only responds to people who have a role on the app (you, plus testers you add under App roles). To make it work for the public:
1. Switch the app to **Live**. That requires a privacy policy URL, which can be a simple page on tomswoope.com.
2. Request **Advanced Access** under App Review for `pages_messaging`, `instagram_manage_messages`, `instagram_manage_comments`, `pages_manage_engagement` and `pages_read_engagement`. Meta wants a short screen recording of the comment → DM flow working with a test user. Review usually takes a few days.
3. Meta may also ask for **Business Verification** for your Business Portfolio.

## Meta's rules to know
- **One private DM per comment**, and only within 7 days of the comment. The bot already enforces this.
- After someone DMs you, you can reply within 24 hours. The bot replies instantly, so this is fine.
- Don't use it for spammy cold messages. Keyword opt-ins like this are exactly what Meta allows.

## Local testing
```bash
npm test
```
This starts the server in dry-run mode with two fake accounts, sends 22 fake webhook events (comments, DMs, bad signatures, dedupe, exact-match, per-post and per-account rules, and routing to the right Page) and checks what would have been sent.
