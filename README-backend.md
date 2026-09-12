# rockawayevents.org backend

Netlify Functions (Node 20, CommonJS `exports.handler`). **Zero npm dependencies**:
everything uses Node's own `fetch`, `crypto` and `zlib`. There is no `node_modules`
to install and nothing for esbuild to bundle beyond our own files.

## Endpoints

| Route | Function | Cache | Notes |
|---|---|---|---|
| `GET /api/events` | `events.js` | 5 min browser, 10 min CDN + SWR 1h | `{ updated, today, count, events[] }` |
| `GET /api/conditions` | `conditions.js` | 15 min | beach conditions, every upstream degrades independently |
| `GET /api/calendar.ics` | `calendar-ics.js` | 1 h | also served at `/calendar.ics` |
| `GET /api/feed.xml` | `rss.js` | 1 h | also served at `/feed.xml` |
| `GET /api/ferry` | `ferry.js` | 6 h | `?date=YYYY-MM-DD`, defaults to today ET |
| `GET /api/pending?key=` | `pending.js` | `no-store` | 401 without the right key |
| `POST /api/moderate` | `moderate.js` | `no-store` | `{ id, action, key, edits? }` |
| `POST /api/subscribe` | `subscribe.js` | `no-store` | `{ email, name?, website? }`, weekly list signup |
| (webhook) | `submission-created.js` | n/a | Netlify Forms calls it by filename |

Shared code lives in `netlify/functions/lib/`:

- `notion.js` - Notion REST helpers: `queryAll` (paginates), `createPage`,
  `updatePage`, `plain`, per-type property getters, `todayET`, `addDays`, the two
  database ids, the Category and Days option lists, `NOTION_VERSION = 2022-06-28`.
- `events-core.js` - `getEvents()`: the single source of truth for the public list.
  Used by `events.js`, `calendar-ics.js` and `rss.js` so all three always agree.
- `auth.js` - constant-time `MODERATE_KEY` check shared by `pending` and `moderate`.
- `ferry-core.js` - copied from jamasha, one line changed (see below).
- `unzip.js` - 90-line ZIP reader on Node's `zlib.inflateRawSync`. Replaces the
  `fflate` npm package that jamasha's `ferry-core.js` imports, which is the only
  reason this project needs no dependencies. Handles stored and deflate entries;
  no zip64 (GTFS feeds are nowhere near 4 GB).
- `email.js` - Resend REST wrapper (`sendEmail`, `addContact`, `templates`), used
  by `submission-created.js`, `moderate.js` and `subscribe.js`. No SDK, global
  `fetch` only, 8 second timeout. Degrades to a logged no-op whenever
  `RESEND_API_KEY` (or `RESEND_AUDIENCE_ID` for `addContact`) is unset, so a
  missing key never fails the request that triggered the email.

## Env vars (Netlify site settings)

| Name | Used by | Purpose |
|---|---|---|
| `NOTION_TOKEN` | events, calendar, rss, pending, moderate, submission-created | same internal integration as jamasha |
| `MODERATE_KEY` | pending, moderate | admin password; 401 on mismatch, 500 when unset |
| `RESEND_API_KEY` | submission-created, moderate, subscribe (via `lib/email.js`) | Resend API key. When unset, every email call logs and returns `{ok:false, skipped:true}` instead of failing the request. |
| `RESEND_AUDIENCE_ID` | subscribe (via `addContact`) | id of the Resend audience the weekly list signs up to |
| `EMAIL_FROM` | submission-created, moderate | From header for outgoing mail; defaults to `Rockaway Events <hello@rockawayevents.org>` |
| `NOTIFY_EMAIL` | submission-created | who gets the "new event submitted" notice; defaults to `jamalknyc@gmail.com` |

`conditions.js` and `ferry.js` need no secrets. Nothing is read from the client.

### Setting up Resend

1. Add `rockawayevents.org` as a sending domain in the Resend dashboard. It will
   ask for three DNS records at the registrar (exact values come from the
   dashboard once the domain is added, they are unique per account):
   - an **MX** record on the `send` subdomain (e.g. `send.rockawayevents.org`)
     pointing at Resend's mail server, so bounce/feedback handling works;
   - a **DKIM TXT** record at `resend._domainkey` with the public key Resend
     generates, so outgoing mail verifies;
   - an **SPF TXT** record on the same `send` subdomain authorizing Resend to
     send as that domain (`v=spf1 include:...`). This is separate from any SPF
     record on the bare domain used for Gmail send-as.
   Verify propagation the same way as the Gmail send-as setup:
   `nslookup -type=mx send.rockawayevents.org 8.8.8.8` and
   `nslookup -type=txt resend._domainkey.rockawayevents.org 8.8.8.8`.
2. Create an Audience in Resend for the weekly list, copy its id into
   `RESEND_AUDIENCE_ID`.
3. Copy the API key into `RESEND_API_KEY` (Netlify site settings > Environment
   variables).

### Weekly newsletter plan

The signup form on the site (`POST /api/subscribe`) only adds contacts to the
Resend audience; it does not itself send anything on a schedule. The weekly
digest is a manual (or later, cron-triggered) **Resend Broadcast** sent to that
audience: pull the coming week's approved events from `/api/events`, drop them
into a broadcast draft in the Resend dashboard (or a small script that calls
the Broadcasts API), and send. Nothing here builds that yet.

## Testing locally

`conditions` and `ferry` hit only free public APIs, so they run for real:

```bash
node -e "require('./netlify/functions/conditions.js').handler({}).then(r=>console.log(r.body))"
node -e "require('./netlify/functions/ferry.js').handler({}).then(r=>console.log(r.body))"
node -e "require('./netlify/functions/ferry.js').handler({queryStringParameters:{date:'2026-09-15'}}).then(r=>console.log(r.body))"
```

Confirm one dead upstream does not blank the rest:

```bash
node -e "const f=global.fetch;global.fetch=(u,o)=>/marine-api|tidesandcurrents/.test(String(u))?Promise.reject(new Error('down')):f(u,o);require('./netlify/functions/conditions.js').handler({}).then(r=>console.log(r.body))"
```

The Notion-backed functions need a token, so drive them with a fetch stub instead:

```bash
# /api/events with one fake Approved row
node -e "
global.fetch=async()=>({ok:true,status:200,json:async()=>({results:[{id:'p1',properties:{
  Event:{title:[{plain_text:'Test Event'}]},
  Date:{date:{start:'2026-09-20'}},
  Time:{rich_text:[{plain_text:'7:30 PM'}]},
  Status:{select:{name:'Approved'}}}}],has_more:false})});
process.env.NOTION_TOKEN='fake';
require('./netlify/functions/events.js').handler({}).then(r=>console.log(r.body))"

# the .ics and the RSS feed off the same stub
node -e "global.fetch=async()=>({ok:true,status:200,json:async()=>({results:[],has_more:false})});process.env.NOTION_TOKEN='fake';require('./netlify/functions/calendar-ics.js').handler({}).then(r=>console.log(r.body))"
node -e "global.fetch=async()=>({ok:true,status:200,json:async()=>({results:[],has_more:false})});process.env.NOTION_TOKEN='fake';require('./netlify/functions/rss.js').handler({}).then(r=>console.log(r.body))"

# moderation auth: expect 401 then 200
node -e "process.env.MODERATE_KEY='k';require('./netlify/functions/moderate.js').handler({httpMethod:'POST',body:JSON.stringify({id:'x',action:'approve',key:'wrong'})}).then(r=>console.log(r.statusCode,r.body))"

# the Netlify Forms webhook, without touching Notion (no token set)
node -e "delete process.env.NOTION_TOKEN;require('./netlify/functions/submission-created.js').handler({body:JSON.stringify({payload:{form_name:'event-submit',data:{event:'Beach Yoga',date:'2026-10-04',category:'Run & Fitness,Surf & Beach',free:'on',url:'example.com/yoga'}}})}).then(r=>console.log(r.statusCode,r.body))"

# subscribe: honeypot short-circuits, then a valid email with no Resend config
node -e "delete process.env.RESEND_API_KEY;require('./netlify/functions/subscribe.js').handler({httpMethod:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'a@b.com',website:'spam'})}).then(r=>console.log(r.statusCode,r.body))"
node -e "delete process.env.RESEND_API_KEY;require('./netlify/functions/subscribe.js').handler({httpMethod:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'not-an-email'})}).then(r=>console.log(r.statusCode,r.body))"
```

Pure functions worth poking at directly:

```bash
node -e "const c=require('./netlify/functions/lib/events-core.js');console.log(c.parseTimeStart('9 AM to 1 PM'),c.parseTimeStart('6-10pm'),c.mapTypes(['Beach Cleanup']))"
node -e "console.log(require('./netlify/functions/conditions.js').lifeguardSeason(2026))"
```

With the Netlify CLI, `npx netlify dev` serves the real routes at
`http://localhost:8888/api/...` using the linked site's env vars.

## Conditions: sources and the tide station

| Source | Gives us |
|---|---|
| Open-Meteo forecast | air temp, feels-like, wind, UV, skies, precip chance, 5 day outlook, sunrise/sunset |
| Open-Meteo marine | wave height (ft), period, direction, modelled sea surface temp |
| NDBC buoy 44065 | measured water temp, and wave fallback if the marine API is down |
| NOAA CO-OPS | next 4 high/low tide predictions |

Each is fetched in its own `try`/`catch` with a 6 second `AbortController` timeout.
A failure adds a line to the response's `errors[]` and leaves that section null;
the endpoint still returns 200. Water temp prefers the buoy (a real measurement)
over the marine model, and reports `water.source` so the frontend can say which.

**Tide station: `8517137`, "Beach Channel (bridge)" (40.5883, -73.8200).**
Picked by pulling every `type=tidepredictions` station from
`https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json` (3,499 of
them) and sorting by great-circle distance from 40.58, -73.82:

| Station | Distance | Name |
|---|---|---|
| **8517137** | **0.57 mi** | **Beach Channel (bridge)** |
| 8516999 | 3.56 mi | J.F.K. International Airport |
| 8517394 | 3.59 mi | Barren Island, Rockaway Inlet |
| 8516881 | 4.16 mi | East Rockaway Inlet, Atlantic Beach |

8517137 is on the Jamaica Bay side of the peninsula rather than the ocean face,
but NOAA publishes no prediction station on the ocean side of Rockaway, and this
is both the nearest tidal signal and a reference (not subordinate) station.
Predictions were confirmed live against the `datagetter` endpoint. It is
hardcoded in `conditions.js` with this rationale in a comment.

## Lifeguards

Season is computed, not hardcoded: the Saturday of Memorial Day weekend (the
Saturday before the last Monday in May) through the **second Sunday of September**.
For 2026 that is May 23 to September 13. That end date is the conservative reading
of "Labor Day weekend plus the following week" and never over-claims a staffed
beach. `onDuty` is true only when in season **and** the current ET hour is
10:00 to 17:59; `inSeason` is exposed separately, along with the note that
swimming is only allowed when lifeguards are on duty.

## Beach score

Starts at 10 and deducts: air below 70 F (scaled, max 5), thunderstorms (4),
rain falling now (3), precip chance above 30 percent (scaled, max 4), wind above
15 mph (scaled, max 3), waves above 4 ft (scaled, max 2), water below 65 F
(scaled, max 2). Clamped to 0 to 10 and rounded. Labels: 8 and up "Great beach
day", 5 to 7 "Decent", below 5 "Not today". UV is a note only, never a penalty:
strong sun does not make it a bad beach day. `reasons[]` is short plain
sentences, no emojis and no em dashes.

## netlify.toml

`publish = "dist"`, functions from `netlify/functions`, `node_bundler = "esbuild"`.
Every `/api/*` route is a **200 rewrite** so the browser keeps the pretty URL.
`/calendar.ics` and `/feed.xml` rewrite to their API routes for nicer subscribe
links. Headers: `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` on
`/*`, `X-Robots-Tag: noindex` plus `no-store` on `/admin` and `/admin/*`, and a
one-year immutable cache on `/icons/*`.
