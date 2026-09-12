# Rockaway Instagram sources for the daily scan

Checklist of Instagram accounts that post Rockaway events, for the daily Instagram scan routine (see `CLAUDE.md` "Routines that feed the DB"). Handles marked "(handle unverified)" were not conclusively confirmed by the research report or by the venue list — verify before wiring into the scan.

---

## Venues / bars / restaurants

- [ ] @adriennesrockaway — Adrienne's (handle unverified)
- [ ] @rippers86 — Rippers, Beach 86th boardwalk (confirmed)
- [ ] @rockawaybeachsurfclub — Rockaway Beach Surf Club, 302 Beach 87th St (confirmed)
- [ ] @thewharf_rockaway — The Wharf, 416 Beach 116th St (confirmed)
- [ ] @tacowaybeach — Tacoway Beach (handle unverified)
- [ ] @salylima_rockaway — Sal y Lima, 88-22 Rockaway Beach Blvd (confirmed)
- [ ] @peteandcubos — Pete and Cubo's, tattoo shop (handle unverified)
- [ ] @picorockaway — Pico, coffee/cafe (handle unverified)
- [ ] @rockawaytikibar — Rockaway Tiki Bar, 67-20 Rockaway Beach Blvd (confirmed)
- [ ] @bungalowbarny — Bungalow Bar, 377 Beach 92nd St (confirmed)
- [ ] @connollysbar — Connolly's, 155 Beach 95th St (confirmed)
- [ ] @murfrockaway — MURF, Jamal & Sasha's gym (handle unverified)
- [ ] @caracasarepabar — Caracas Arepa Bar, 106-01 Shore Front Pkwy (confirmed)
- [ ] @tapthatrbny — Tap That, 111-04 Rockaway Beach Blvd (confirmed)
- [ ] @rosedenrockaway — Rose Den (handle unverified)
- [ ] @calliesrockaway — Callie's, Beach 129th St (handle unverified)
- [ ] @rockawaybazaar — Rockaway Bazaar (handle unverified; try rockaway-bazaar.com directly)
- [ ] @riisbeach.nyc — Riis Park Beach Bazaar / Riis Beach Co., Jacob Riis Park boardwalk (confirmed)
- [ ] @beach97th — Beach 97th Concessions boardwalk hub (confirmed)
- [ ] @therockawayhotel — The Rockaway Hotel + Spa, 108-10 Rockaway Beach Dr (confirmed)

## Community orgs

- [ ] @riserockaway — RISE (formerly Rockaway Waterfront Alliance), 58-03 Rockaway Beach Blvd (confirmed)
- [ ] @jbrpc — Jamaica Bay-Rockaway Parks Conservancy (confirmed)
- [ ] @queenscb14 — Queens Community Board 14 (confirmed)
- [ ] @rbca_nyc — Rockaway Beach Civic Association (confirmed)
- [ ] @belleharborpoa — Belle Harbor Property Owners Association (confirmed)
- [ ] @rockaway_artists_alliance — Rockaway Artists Alliance, Fort Tilden (confirmed)
- [ ] @rockawaytheatreco — Rockaway Theatre Company, Fort Tilden (confirmed)

## Run / surf / fitness groups

- [ ] @rockawaytc — Rockaway Track Club (handle unverified, report could not confirm)
- [ ] @localssurfschool — Locals Surf School, Beach 69th St (confirmed)
- [ ] @skudinsurf — Skudin Surf Rockaway (confirmed)
- [ ] @sierrasurfschool — Sierra Surf School, Beach 67th St (confirmed)
- [ ] @seachanges_rockaways — Sea Changes Rockaways cold-water swim group (confirmed)
- [ ] @rbbunderground — Rockaway Beach Bodysurf Underground (confirmed)
- [ ] @surfridernyc — Surfrider Foundation NYC (confirmed)
- [ ] @ymcanyc — Rockaway YMCA (confirmed, citywide account)

## Media

- [ ] @rockawaytimes — The Rockaway Times, weekly "Things To Do" and "Rockaway Good Times" roundups (confirmed, highest-value account)
- [ ] @therockawaywave — The Wave, "What's On" local events calendar (confirmed)
- [ ] @rockawaybeachny — Rockaway Beach NY, broad community repost account (confirmed)
- [ ] @strongbuzz_ — The Strong Buzz / Andrea Strong's Substack (handle unverified, verify through Substack)
- [ ] @gatewaynps — NPS Gateway National Recreation Area, ranger programs (confirmed)

## Markets

- [ ] @grownyc — GrowNYC, runs Rockaway Beach Youthmarket/Greenmarket (confirmed)
- [ ] @rockawayyouth — Rockaway Youth Task Force, Youthmarket partner (handle unverified)
- [ ] @rockawaymakersmkt — a Rockaway makers market account referenced in the report's sources (handle unverified, confirm relevance and cadence)

## Parks / government

- [ ] @nycparks — NYC Parks, Rockaway boardwalk events, Shape Up NYC classes, summer concerts (confirmed)
- [ ] @nycferry — NYC Ferry Rockaway route alerts and occasional pop-up events (confirmed)
- [ ] @qplnyc — Queens Public Library, storytimes/crafts/programs at Far Rockaway, Arverne, Peninsula, Seaside, Broad Channel branches (confirmed)

---

## Non-Instagram sources

- **Rockaway Times things-to-do feed (WP REST API):** `https://rockawaytimes.com/wp-json/wp/v2/posts?categories=48&per_page=1` — machine-readable, best for automated ingestion of the weekly "Things To Do" roundup.
- **Rockaway Times "Rockaway Good Times" (bar/live-music listings):** `https://rockawaytimes.com/category/things-to-do/` and search `rockawaytimes.com/rockaway-good-times-*` for the current week's issue number.
- **NYC Parks Rockaway Beach and Boardwalk events page:** `https://www.nycgovparks.org/parks/rockaway-beach-and-boardwalk/events`
- **NYC Parks free summer concerts:** `https://www.nycgovparks.org/events/free_summer_concerts`
- **Eventbrite search (Rockaway Beach):** `https://www.eventbrite.com/d/ny--far-rockaway/events/` or a keyword search for "Rockaway Beach"
- **Surfrider Foundation NYC:** `https://nyc.surfrider.org/` (cleanups calendar) and `https://cleanups.surfrider.org/`
- **RISE events calendar:** `https://www.riserockaway.org/rise/events/`
- **JBRPC events calendar:** `http://www.jbrpc.org/events` (Rockaway Refresh cleanups: `?category=Refresh`)
- **NPS Gateway National Recreation Area calendar:** `https://www.nps.gov/gate/planyourvisit/calendar.htm`
- **Queens Community Board 14 calendar:** `https://www.nyc.gov/site/queenscb14/calendar/calendar.page`
- **Queens Public Library calendar:** `https://www.queenslibrary.org/calendar` (filterable by branch and program type)
- **Rockaway Podcast / RockPod calendar:** `https://www.rockawaypodcast.com/calendar/rockaway/`
- **The Wave "What's On":** `https://www.thewave.com/whats-on/`
- **The Strong Buzz (Substack):** `https://andreastrong.substack.com/`
- **Friends of Rockaway Beach (Facebook group):** `https://www.facebook.com/groups/346878535454797/`
- **Rockaway Time app (new 2026):** `https://rockawaytimes.com/rockaway-time-app/` — The Rockaway Times' peninsula guide app (events, weather, tides, swell, beach conditions); no public API found, may require manual checking or a partnership conversation.
- **ROCK! AWAY! / Max Power app-site (new 2026):** `https://maxpowerrockaway.com/` — launched for the 2026 ROCK! AWAY! Summer Fest, aims to become a year-round guide; no public API found.
- **GrowNYC market locations:** `https://grownyc.org/locations/`
- **Riis Beach Co.:** `https://www.riisbeach.nyc/events-this-week`

## Verified additions

- **@rockawayrunningclub** (VERIFIED 2026-09-12): Rockaway Running Club. Free 3-mile group runs, Tue 6:30 AM and Thu 6 PM from the boardwalk at Beach 81st St. Note: @rockawayrunclub is an empty placeholder account, do not use it.
