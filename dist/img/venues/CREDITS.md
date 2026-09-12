# Venue photo credits

Every file in this folder is a photograph of the real Rockaway place it is named after. That is the whole point of the folder: `/img/fallback/` is stock that is never of anywhere in Rockaway, and `dist/index.html` was putting the same stock bar interior on two different bars. These are the opposite. One file per place, never reused across places, every one of them traceable to the source below.

Sourcing order was Instagram first (the venue's own account, read only, via Claude in Chrome), then the venue's own website, then Wikimedia Commons for the civic places that have neither. Instagram post photos were pulled through the public `/embed/captioned/` view of the post that was chosen in the browser; the Instagram CDN URL itself is never stored anywhere, because those URLs are signed and expire within days.

Saved by `node scripts/save-venue-photo.js <url-or-file> <slug>`: max 1200 px on the long edge, JPEG quality 80, progressive, metadata stripped. 16 files, 2.09 MB total.

**No AI-generated images. No Street View or Maps screenshots. No watermarked photos.**

## From the venue's own Instagram

| File | Place | Account | Post | Shows |
| --- | --- | --- | --- | --- |
| `bungalow-bar.jpg` | Bungalow Bar, 377 Beach 92nd St | [@bungalowbarny](https://www.instagram.com/bungalowbarny/) | [Db82P2bFmc2](https://www.instagram.com/p/Db82P2bFmc2/) | The outdoor bar on the bay side, chalkboard reading "TODAY: Game Night @ 7PM" |
| `connollys.jpg` | Connolly's, 155 Beach 95th St | [@connollysbar](https://www.instagram.com/connollysbar/) | [DdHYf6Qp7Fa](https://www.instagram.com/p/DdHYf6Qp7Fa/) | The back bar with the carved Connolly's sign over it |
| `caracas.jpg` | Caracas Rockaway, 106-01 Shore Front Pkwy | [@caracasarepabar](https://www.instagram.com/caracasarepabar/) | [Db0_-X_hMJU](https://www.instagram.com/p/Db0_-X_hMJU/) | A band playing under the awning at the boardwalk stand, green wall behind them |
| `riis-beach.jpg` | Riis Beach Co., Jacob Riis Park | [@riisbeach.nyc](https://www.instagram.com/riisbeach.nyc/) | [DOfDaB1EUUH](https://www.instagram.com/p/DOfDaB1EUUH/) | Yellow umbrellas and blue picnic tables on the Riis boardwalk, ocean behind |
| `rockaway-running-club.jpg` | Rockaway Running Club, boardwalk at Beach 81st St | [@rockawayrunningclub](https://www.instagram.com/rockawayrunningclub/) | [DbTt7TimlEO](https://www.instagram.com/p/DbTt7TimlEO/) | The group after a run, on the boardwalk with coffees up |

## From the venue's own website

| File | Place | Page | Shows |
| --- | --- | --- | --- |
| `rippers.jpg` | Rippers, 86-01 Shore Front Pkwy | [eatrippers.com](https://www.eatrippers.com/) | The green building and shade sails on the boardwalk, line at the window |
| `tap-that.jpg` | Tap That, 111-04 Rockaway Beach Blvd | [tapthatrbny.com](https://www.tapthatrbny.com/) | The building front with the "TAP THAT, self pour tap parlor" sign |
| `rockaway-hotel-pool.jpg` | The Rockaway Hotel pool, 108-10 Rockaway Beach Dr | [therockawayhotel.com](https://www.therockawayhotel.com/pool) | The pool itself, loungers and umbrellas around it |
| `rockaway-hotel-rooftop.jpg` | The Rockaway Hotel rooftop | [therockawayhotel.com/rockaway-hotel-rooftop](https://www.therockawayhotel.com/rockaway-hotel-rooftop) | The rooftop terrace looking over Jamaica Bay to the Manhattan skyline |
| `rise-center.jpg` | RISE Center, 58-03 Rockaway Beach Blvd | [riserockaway.org](https://www.riserockaway.org/rise/about/) | The old firehouse with the green RISE mural on it |
| `rockaway-market-street.jpg` | Rockaway Market Street, Beach 60th St and Straiton Ave | [rockawaymarket.org](https://rockawaymarket.org/) | Vendor tents and shoppers under the elevated A train |

The two Rockaway Hotel photos came off the hotel's own site rather than its Instagram on purpose. The hotel's Instagram has plenty of pool-deck and terrace atmosphere, but nothing that plainly reads "here is the pool" and "here is the rooftop", and those two cards exist precisely to stop the pool night and the rooftop night looking identical.

## From Wikimedia Commons

Civic places with no venue Instagram and no venue website of their own. Attribution is required by these licences and this file is that attribution.

| File | Place | Photographer | Licence | File page |
| --- | --- | --- | --- | --- |
| `seaside-library.jpg` | Seaside Library, 116-15 Rockaway Beach Blvd | Tdorante10 | CC BY-SA 4.0 | [File page](https://commons.wikimedia.org/wiki/File:From_the_Q22_td_(2023-09-04)_061_-_Seaside_Library.jpg) |
| `far-rockaway-library.jpg` | Far Rockaway Library, 1637 Central Ave | Tdorante10 | CC BY-SA 4.0 | [File page](https://commons.wikimedia.org/wiki/File:Mott_Av_Central_Av_td_05_-_Far_Rockaway_Library.jpg) |
| `broad-channel-library.jpg` | Broad Channel Library, 16-26 Cross Bay Blvd | Commons contributor, see file page | CC BY-SA 3.0 | [File page](https://commons.wikimedia.org/wiki/File:Queens_Library-Broad_Channel.jpg) |
| `rockaway-boardwalk.jpg` | Rockaway Beach Boardwalk | Jessica Sheridan | CC BY 2.0 | [File page](https://commons.wikimedia.org/wiki/File:Rockaway_Beach_(9639553883).jpg) |
| `jamaica-bay-refuge.jpg` | Jamaica Bay Wildlife Refuge, East Pond | Rhododendrites | CC BY-SA 4.0 | [File page](https://commons.wikimedia.org/wiki/File:Jamaica_Bay_Wildlife_Refuge_East_Pond_(61289p).jpg) |

`far-rockaway-library.jpg` is the one to re-check if anyone is passing by. The Commons file is titled as the Far Rockaway Library and was shot at Mott and Central, which is the right corner, but the building sits at the edge of the frame rather than filling it. It is the branch, not a lookalike, and it is still a weaker picture than the other two libraries.

## Could not be sourced

These places recur in the feed and still have no photograph of their own. They fall through to a stock category photo, which claims nothing, rather than to a lookalike, which would claim something false. If a photo turns up later, drop it in here and add the rule back to `VENUE_IMAGES`.

| Place | Why not |
| --- | --- |
| Beach 97th Street concessions | [@beach97th](https://www.instagram.com/beach97th/) posts flyers and lineup graphics almost exclusively; beach97.com is an unfinished template site with stock art on it. |
| Rockaway Beach Youthmarket, Beach 67th to 69th | GrowNYC's page for it carries only generic GrowNYC program photos from other markets. @rockawayyouth is the Rockaway Youth Task Force's own farm on Beach 58th, which is a different place, and its account stopped posting in 2021. |
| Knights of Columbus, 333 Beach 90th St | Commons has two photographs of the 9/11 memorial plaque and steel cross outside a KofC hall, and nothing of the building. No usable hall photo found. |
| Beach 95th Street amphitheater | Nothing on Commons, nothing on the NYC Parks page (nycgovparks.org serves its gallery at thumbnail size only). The one event there this season carries its own og:image anyway. |
| MURF, Muscle Up Rockaway Fitness | murfclub.com has a single photo, which is a framed Arnold poster on a wall, and the Instagram is entirely promo graphics. Not in the live feed either, so no card needs it yet. |
| Beach 60th Street boardwalk | Commons only has the subway station and the street under the elevated, both shot in winter. Cardio Punch and Boardwalk Bootcamp both point at `rockaway-boardwalk.jpg` instead, which is a photograph of the boardwalk they are held on, a few blocks along. |

## Rebuilding

```
node scripts/save-venue-photo.js "<image url or local file>" <slug> [--force]
```

Then point a rule at the slug in `TITLE_IMAGES` or `VENUE_IMAGES` in `dist/index.html`, and add a row here. A file with no row here does not belong in this folder.
