# Site geolocation — address lookup and coordinates — design

Date: 2026-08-03
Branch: `org-sites`
Status: design approved in conversation; not yet planned or built
Builds on: `2026-07-31-organization-site-design.md` (Site record, §4.2)

## 1. Purpose

A Site record currently carries `address`, `city`, `province` and `postalCode` as four independent
free-text fields. Nothing validates them, nothing relates them, and nothing ties the record to a
place on earth. Two consequences:

- Addresses are typed by hand, so they drift — abbreviations, missing postal codes, typos.
- A site cannot be plotted, measured against another site, or checked against reality.

This adds an **on-demand address lookup** that resolves a typed address to a real one and stores
its coordinates, making the address trustworthy and the site locatable.

## 2. Scope

**In:**

- A Look up action on the address field of the Site record (create modal and edit mode).
- The same action on the Organization record's `address` field.
- New `lat` / `lon` / `geocodedAt` / `geocodeSource` keys on the Site record.
- A pure `haversineKm()` distance function.
- Three settings (§3.4): enable the feature (default off), the endpoint, and a country filter.

**Out — and why:**

| Excluded | Reason |
|---|---|
| Typeahead / autocomplete | Prohibited by Nominatim's usage policy (§3.1), and it inverts the plugin's network posture (§4) |
| Travel-time between sites | Needs a routing service — a second egress path and a second dependency. Straight-line distance ships now; travel-time reopens the network question |
| A map view of sites | Belongs with P22_CampusMap, not here. This spec produces the coordinates that feed such a view |
| Reverse geocoding (coords → address) | No use case yet |
| Bulk/backfill geocoding of existing sites | Would be a repeated automated query pattern; revisit only if there are enough sites to matter |

## 3. Service

### 3.1 Choice: Nominatim (OpenStreetMap)

Free, no API key, no account, no credential to store in the vault.

Its usage policy was read rather than recalled
(<https://operations.osmfoundation.org/policies/nominatim/>, retrieved 2026-08-03):

- **Rate:** "1 request per second" for normal use.
- **Identification:** requires "a valid HTTP Referer or User-Agent identifying the application
  (stock User-Agents as set by http libraries will not do)."
- **Autocomplete:** "This is not yet supported by Nominatim and you must not implement such a
  service on the client side using the API." — decisive, and the reason this design is on-demand.
- **Caching:** required, not merely permitted. "Results must be cached on your side."
- **Licence:** ODbL, share-alike.

One request per deliberate button press satisfies the rate limit by construction rather than by
throttling logic.

**Alternatives considered.** *Photon (Komoot)* is keyless and built for typeahead, but typeahead is
out of scope, which removes its only advantage. *Geocoder.ca* throttles its free tier and funnels
toward paid credits. *Google Places* needs a billed API key, and its terms restrict retention of
returned data — a poor fit for records meant to persist in a vault.

### 3.2 No lock-in

The endpoint is a setting, defaulting to the public instance. Pointing it at a self-hosted
Nominatim gives zero third-party egress with no other change. The response parser targets
Nominatim's `jsonv2` shape; swapping to a different provider means changing the parser, which is
isolated in one pure function (§7) for exactly that reason.

### 3.3 Request

```
GET <endpoint>?q=<address>&format=jsonv2&addressdetails=1&limit=5&countrycodes=<cc>
User-Agent: obsidi-office/<manifest version> (Obsidian plugin)
```

Issued with `obsidian.requestUrl` — CORS-free and works on desktop and iPad. Precedent exists in
this plugin (asset-zip download).

`countrycodes` defaults to `ca` and is a setting; blank means unrestricted.

### 3.4 Settings

Added to `DEFAULT_SETTINGS`, surfaced in the plugin's settings tab under a "Site geolocation"
heading:

| Setting | Default | Notes |
|---|---|---|
| `geocodingEnabled` | `false` | Off means no control and no requests (§4) |
| `geocodingEndpoint` | `https://nominatim.openstreetmap.org/search` | Point at a self-hosted instance for zero third-party egress |
| `geocodingCountryCodes` | `ca` | Comma-separated ISO codes; blank means unrestricted |

The settings tab states plainly that enabling this sends the typed address to the configured
endpoint when the button is pressed. A user should not have to read this spec to know that.

## 4. Network posture

**This is the load-bearing decision.** Today the plugin is network-silent: the only outbound
request is a user-triggered asset download. This feature must not change that by default.

- Setting `geocodingEnabled`, **default `false`**.
- While disabled the Look up control is **not rendered** — absent, not disabled. No dead affordance,
  and no way to emit a request by accident.
- While enabled, a request is emitted **only** on an explicit button press. Never on typing, focus,
  blur, save, render or load.

The address text is what leaves the machine, and only at that moment. Nothing else about the
record — name, organization, tags, summary — is ever transmitted.

## 5. Data model

Added to `SITE_FIELDS` in `lib/doc-container.js`:

| Key | Type | Format | Purpose |
|---|---|---|---|
| `lat` | text | WGS84 decimal degrees, 6 dp | Latitude |
| `lon` | text | WGS84 decimal degrees, 6 dp | Longitude |
| `geocodedAt` | text | `YYYY-MM-DD` | Reveals a coordinate older than the address beside it |
| `geocodeSource` | text | e.g. `nominatim` | Distinguishes a looked-up coordinate from a hand-entered one |

Six decimal places and the `{lat, lon}` naming match P22_CampusMap's `wgs84` shape
(`P22_CampusMap/src/types.ts`, `AssetPos`) so a site can feed that project without conversion.

`lat` and `lon` are ordinary **editable text fields**. This is deliberate: with geocoding disabled
a user can paste coordinates from any map and still get every downstream benefit. The zero-network
path is a first-class path, not a degraded one.

Organization records gain no coordinate keys — the Look up action there fills `address` only.
A site is a place; an organization is a party that may have many.

Absent keys mean "not geocoded". Values are never written as empty strings (consistent with the
existing `delete fm[k]` behaviour for cleared entity fields).

## 6. Interaction

Applies to the Site create modal, the Site record in edit mode, and the Organization record in
edit mode.

1. The user types an address, in any form.
2. They press **Look up**. The button enters a pending state; one request goes out.
3. Up to five candidates render as a list, each showing its formatted display name.
4. Selecting one fills the fields. Dismissing changes nothing.

**Nothing is ever overwritten without a selection.** No auto-pick when there is exactly one result:
a single confident-looking wrong answer is the failure mode most likely to go unnoticed.

On selection, for a Site:

| Field | Source |
|---|---|
| `address` | `[address.house_number, address.road].filter(Boolean).join(' ')`. If that is empty, the first comma-separated segment of `display_name` |
| `city` | `address.city` ?? `town` ?? `village` ?? `municipality` |
| `province` | `address.state` |
| `postalCode` | `address.postcode` |
| `lat` / `lon` | `lat` / `lon`, rounded to 6 dp |
| `geocodedAt` | today, `YYYY-MM-DD` |
| `geocodeSource` | `nominatim` |

For an Organization, `address` only.

Fields whose source component is absent are left untouched rather than blanked — a partial match
must not destroy correct data the user already typed.

## 7. Structure

Pure, in `lib/doc-container.js` — unit-tested, no network, no Obsidian API:

- `parseGeocodeResults(json)` → `[{ display, address, city, province, postalCode, lat, lon }]`.
  The whole provider-shape dependency lives here (§3.2).
- `haversineKm(a, b)` → number. Great-circle distance between two `{lat, lon}` pairs.
- `formatCoord(n)` → 6-dp string, or `null` for a non-finite input.

Runtime, in `main.js`:

- `geocodeAddress(query)` — builds the request, calls `requestUrl`, hands the body to
  `parseGeocodeResults`. The only function that touches the network; a thin seam so the pure parser
  can be tested against captured fixtures.
- `openGeocodePicker(results, onPick)` — the candidate list.
- Wiring in `EntityCreateModal` and `renderEntityView`'s edit mode.

## 8. Error handling

| Condition | Behaviour |
|---|---|
| `geocodingEnabled` false | Control not rendered |
| Empty address | Button inert; no request |
| Request throws / offline / non-200 | `Notice`: lookup failed, try again or enter coordinates manually. Form untouched |
| Zero results | `Notice`: no match; suggest refining or entering coordinates manually. Form untouched |
| Multiple results | **Not an error** — the normal path. Render the picker |
| Malformed response | Treated as zero results; parse failures never throw into the UI |

The button is disabled while a request is in flight, so a double-click cannot produce two requests.
Combined with one-request-per-press, no burst is reachable.

**Caching**, per the policy's requirement: the stored coordinate *is* the cache. A resolved address
is never automatically re-queried — re-lookup happens only when the user presses the button again.

## 9. Licensing

OSM data is ODbL, share-alike. Storing coordinates for internal records falls within the small
extraction / fair dealing allowance the policy describes, and these records are not published.
Recorded here so the position is explicit rather than assumed. If site data is ever published
externally, attribution obligations need review at that point.

## 10. Testing

**Pure (`node --test lib/doc-container.test.js`)** — these carry the correctness burden:

- `parseGeocodeResults` against captured Nominatim fixtures: a full match, a match missing
  `postcode`, a match missing `city` but carrying `town`, an empty array, and a malformed body.
- `haversineKm`: a known pair (Baycrest ↔ downtown Toronto) to ~1 km, zero for identical points,
  symmetry, and correct sign handling across the equator/meridian.
- `formatCoord`: rounding to 6 dp, and `null` for `NaN` / `Infinity` / non-numeric.
- `SITE_FIELDS` carries the four new keys and they are document-level, not version-level.

**Manual (desktop, then iPad):**

- Feature hidden with the setting off; no request in the Network tab while typing an address.
- Look up with a real address fills every field and writes plausible coordinates.
- An ambiguous query returns a list; dismissing it changes nothing.
- A deliberately bad address reports no match and leaves the form intact.
- Airplane mode reports failure cleanly.
- Manual `lat`/`lon` entry persists with the setting off.

## 11. Acceptance criteria

1. With `geocodingEnabled` off, the plugin emits no geocoding request under any interaction, and
   the control is absent from every surface.
2. With it on, a request is emitted only on an explicit button press.
3. Every outbound request carries an identifying `User-Agent` and cannot exceed one request per
   press.
4. Selecting a candidate fills address, city, province, postal code, `lat`, `lon`, `geocodedAt` and
   `geocodeSource` on a Site; address only on an Organization.
5. No field is modified without an explicit selection, and absent response components leave existing
   values untouched.
6. `lat` / `lon` are manually editable and persist with geocoding disabled.
7. `haversineKm` returns a correct distance between two site records, verified against a known pair.
8. Stored coordinates match P22_CampusMap's `wgs84 {lat, lon}` shape at 6 dp.
9. Every failure mode in §8 leaves the form unchanged and reports through a `Notice`.
10. The endpoint is configurable and a self-hosted Nominatim works without other changes.
