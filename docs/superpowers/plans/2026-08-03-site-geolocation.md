# Site Geolocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a Site record an on-demand address lookup that resolves a typed address to a real one and stores its WGS84 coordinates.

**Architecture:** All parsing and maths live as pure functions in `lib/doc-container.js` (Node-testable, no Obsidian, no network). Exactly one function in `main.js` touches the network, behind an opt-in setting that is off by default. The candidate picker writes into the existing edit-mode input map, so no new save path is introduced.

**Tech Stack:** Plain JavaScript, no build step. `node --test` for pure-core tests. `obsidian.requestUrl` for the single HTTP call. Nominatim (OpenStreetMap) as the geocoding service.

**Spec:** `docs/superpowers/specs/2026-08-03-site-geolocation-design.md`

## Global Constraints

Every task inherits these. Values are copied verbatim from the spec.

- `geocodingEnabled` defaults to **`false`**. While off, the Look up control is **not rendered** — absent, not disabled.
- A request is emitted **only** on an explicit button press. Never on typing, focus, blur, save, render or load.
- Every request sends `User-Agent: obsidi-office/<manifest version> (Obsidian plugin)`. Nominatim's policy rejects stock library user-agents.
- Default endpoint `https://nominatim.openstreetmap.org/search`; default `geocodingCountryCodes` is `ca` (blank means unrestricted).
- **Never implement typeahead.** Nominatim's policy: "you must not implement such a service on the client side using the API."
- Coordinates are WGS84 decimal degrees at **6 decimal places**, stored as `lat` / `lon` — matching `P22_CampusMap/src/types.ts` `AssetPos.wgs84`.
- **No auto-pick, even on a single result.** A selection is always explicit.
- Absent response components **leave existing field values untouched**. Never blank a field the user typed.
- Values are never written as empty strings. An absent key means "not geocoded".
- Pure functions go in `lib/doc-container.js`. Network code goes in `main.js`. Never the reverse.
- **After ANY edit to `lib/doc-container.js`, run `node scripts/inline-doc-container.js`** to regenerate the copy inlined into `main.js` between the `// <doc-container-core>` markers. Editing that block in `main.js` by hand is a bug.
- Verification commands (there is no `package.json` scripts block):
  - `node --test lib/doc-container.test.js`
  - `node --check main.js`

**Working directory for all commands:** `C:\Users\paulc\GrandpaProjects\Obsidian\P21_OnlyOffice\obsidi-office`
**Branch:** `org-sites`

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `lib/doc-container.js` | Pure core: field definitions, coordinate helpers, response parser | Modify — add 4 `SITE_FIELDS` entries, 5 functions, 5 exports |
| `lib/doc-container.test.js` | Pure-core tests | Modify — append ~20 tests |
| `main.js` | Runtime: settings, network call, picker, wiring | Modify — 3 settings, 1 settings-tab section, 2 methods, 2 wiring points |
| `main.js` lines 29–708 | Inlined copy of the pure core | **Generated** — never hand-edited |

---

### Task 1: Coordinate helpers and the four new Site fields

**Files:**
- Modify: `lib/doc-container.js` (`SITE_FIELDS` array; new functions; `module.exports`)
- Test: `lib/doc-container.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `formatCoord(n)` → `string | null` — 6-dp string, `null` for non-finite/non-numeric
  - `parseCoord(v)` → `number | null` — number from a string or number, `null` if unusable
  - `siteCoord(rec)` → `{ lat: number, lon: number } | null`
  - `haversineKm(a, b)` → `number` — great-circle km between two `{lat, lon}`
  - `SITE_FIELDS` gains keys `lat`, `lon`, `geocodedAt`, `geocodeSource` (all `type: 'text'`)

- [ ] **Step 1: Write the failing tests**

Append to `lib/doc-container.test.js`:

```js
// 2026-08-03: site geolocation — coordinate helpers
test('formatCoord: rounds to 6 decimal places', () => {
  assert.strictEqual(dc.formatCoord(43.72911234), '43.729112');
  assert.strictEqual(dc.formatCoord(-79.4394), '-79.439400');
  assert.strictEqual(dc.formatCoord(0), '0.000000');
});

test('formatCoord: null for non-finite or non-numeric', () => {
  assert.strictEqual(dc.formatCoord(NaN), null);
  assert.strictEqual(dc.formatCoord(Infinity), null);
  assert.strictEqual(dc.formatCoord(-Infinity), null);
  assert.strictEqual(dc.formatCoord('abc'), null);
  assert.strictEqual(dc.formatCoord(null), null);
  assert.strictEqual(dc.formatCoord(undefined), null);
});

test('parseCoord: accepts numbers and numeric strings, rejects junk', () => {
  assert.strictEqual(dc.parseCoord(43.729112), 43.729112);
  assert.strictEqual(dc.parseCoord('43.729112'), 43.729112);
  assert.strictEqual(dc.parseCoord('  -79.4394 '), -79.4394);
  assert.strictEqual(dc.parseCoord(''), null);
  assert.strictEqual(dc.parseCoord('north'), null);
  assert.strictEqual(dc.parseCoord(null), null);
});

test('siteCoord: returns a pair only when BOTH lat and lon parse', () => {
  assert.deepStrictEqual(dc.siteCoord({ lat: '43.729112', lon: '-79.439400' }),
    { lat: 43.729112, lon: -79.4394 });
  assert.strictEqual(dc.siteCoord({ lat: '43.729112' }), null);
  assert.strictEqual(dc.siteCoord({ lon: '-79.4394' }), null);
  assert.strictEqual(dc.siteCoord({ lat: 'x', lon: 'y' }), null);
  assert.strictEqual(dc.siteCoord({}), null);
});

test('haversineKm: Baycrest to downtown Toronto is about 9 km', () => {
  const baycrest = { lat: 43.729112, lon: -79.439400 };
  const downtown = { lat: 43.653226, lon: -79.383184 };
  const d = dc.haversineKm(baycrest, downtown);
  assert.ok(d > 8 && d < 10, `expected 8-10 km, got ${d}`);
});

test('haversineKm: zero for identical points, and symmetric', () => {
  const a = { lat: 43.729112, lon: -79.4394 };
  const b = { lat: 45.4215, lon: -75.6972 };
  assert.strictEqual(dc.haversineKm(a, a), 0);
  assert.ok(Math.abs(dc.haversineKm(a, b) - dc.haversineKm(b, a)) < 1e-9);
});

test('haversineKm: handles sign changes across equator and meridian', () => {
  const d = dc.haversineKm({ lat: -1, lon: -1 }, { lat: 1, lon: 1 });
  assert.ok(d > 310 && d < 320, `expected ~314 km, got ${d}`);
});

test('SITE_FIELDS carries lat, lon, geocodedAt and geocodeSource as text', () => {
  const byKey = {}; for (const f of dc.SITE_FIELDS) byKey[f.key] = f;
  for (const k of ['lat', 'lon', 'geocodedAt', 'geocodeSource']) {
    assert.ok(byKey[k], `missing SITE_FIELDS entry: ${k}`);
    assert.strictEqual(byKey[k].type, 'text', `${k} should be text so it stays manually editable`);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/doc-container.test.js`
Expected: FAIL — `dc.formatCoord is not a function`.

- [ ] **Step 3: Add the four fields to `SITE_FIELDS`**

In `lib/doc-container.js`, insert these four entries into `SITE_FIELDS` immediately after the `postalCode` entry and before `status`:

```js
  { key: 'lat',           label: 'Latitude',      type: 'text' },
  { key: 'lon',           label: 'Longitude',     type: 'text' },
  { key: 'geocodedAt',    label: 'Geocoded',      type: 'text' },
  { key: 'geocodeSource', label: 'Coord Source',  type: 'text' },
```

They are `text` on purpose: that keeps `lat`/`lon` hand-editable so the zero-network path (paste coordinates from any map) works with geocoding disabled.

- [ ] **Step 4: Implement the helpers**

Add to `lib/doc-container.js`, just above the `module.exports` block:

```js
// ── Site geolocation (spec 2026-08-03) ──────────────────────────────────────
// WGS84 decimal degrees at 6 dp, matching P22_CampusMap's AssetPos.wgs84 so a
// site can feed that project without conversion.

function formatCoord(n) {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return null;
  return v.toFixed(6);
}

function parseCoord(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function siteCoord(rec) {
  const lat = parseCoord(rec && rec.lat);
  const lon = parseCoord(rec && rec.lon);
  if (lat == null || lon == null) return null;
  return { lat, lon };
}

// Great-circle distance in km. Pure maths — no service, no network.
function haversineKm(a, b) {
  const R = 6371;                       // mean Earth radius, km
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
```

Then add to the `module.exports` object:

```js
  formatCoord,
  parseCoord,
  siteCoord,
  haversineKm,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test lib/doc-container.test.js`
Expected: PASS — all prior tests still green, 8 new ones added.

- [ ] **Step 6: Regenerate the inlined core**

Run: `node scripts/inline-doc-container.js`
Then: `node --check main.js`
Expected: no output from the check.

Confirm the new code actually landed in the generated block:

```bash
awk 'NR>=29 && NR<=760 && /function haversineKm/' main.js
```
Expected: one matching line. If empty, the inline script did not run.

- [ ] **Step 7: Commit**

```bash
git add lib/doc-container.js lib/doc-container.test.js main.js
git commit -m "feat(geo): coordinate helpers and lat/lon fields on the Site record"
```

---

### Task 2: Nominatim response parser

**Files:**
- Modify: `lib/doc-container.js` (new function; `module.exports`)
- Test: `lib/doc-container.test.js`

**Interfaces:**
- Consumes: `formatCoord` from Task 1.
- Produces: `parseGeocodeResults(json)` → array of
  `{ display: string, address: string, city: string, province: string, postalCode: string, lat: string, lon: string }`.
  All string fields; `lat`/`lon` are 6-dp strings. Returns `[]` for anything unusable — **never throws**.

**Why this is its own task:** it is the entire provider-shape dependency. Swapping geocoding providers later means changing this one function and its fixtures, nothing else.

**Gotcha the implementer must know:** Nominatim returns `lat` and `lon` as **strings**, not numbers. Entries whose coordinates do not parse are dropped.

- [ ] **Step 1: Write the failing tests**

Append to `lib/doc-container.test.js`:

```js
// 2026-08-03: site geolocation — Nominatim jsonv2 parsing
const NOMINATIM_FULL = [{
  lat: '43.7291123', lon: '-79.4394002',
  display_name: '3560, Bathurst Street, North York, Toronto, Ontario, M6A 2E1, Canada',
  address: {
    house_number: '3560', road: 'Bathurst Street', suburb: 'North York',
    city: 'Toronto', state: 'Ontario', postcode: 'M6A 2E1',
    country: 'Canada', country_code: 'ca',
  },
}];

test('parseGeocodeResults: maps a full match to flat fields', () => {
  const r = dc.parseGeocodeResults(NOMINATIM_FULL);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].address, '3560 Bathurst Street');
  assert.strictEqual(r[0].city, 'Toronto');
  assert.strictEqual(r[0].province, 'Ontario');
  assert.strictEqual(r[0].postalCode, 'M6A 2E1');
  assert.strictEqual(r[0].lat, '43.729112');
  assert.strictEqual(r[0].lon, '-79.439400');
  assert.ok(r[0].display.startsWith('3560, Bathurst Street'));
});

test('parseGeocodeResults: missing postcode yields empty string, not undefined', () => {
  const r = dc.parseGeocodeResults([{
    lat: '43.7', lon: '-79.4', display_name: 'Somewhere, Ontario, Canada',
    address: { road: 'Some Road', city: 'Toronto', state: 'Ontario' },
  }]);
  assert.strictEqual(r[0].postalCode, '');
  assert.strictEqual(r[0].address, 'Some Road');
});

test('parseGeocodeResults: falls back through town and village for city', () => {
  const town = dc.parseGeocodeResults([{
    lat: '44.0', lon: '-79.0', display_name: 'X',
    address: { road: 'Main St', town: 'Aurora', state: 'Ontario' },
  }]);
  assert.strictEqual(town[0].city, 'Aurora');

  const village = dc.parseGeocodeResults([{
    lat: '44.0', lon: '-79.0', display_name: 'X',
    address: { road: 'Main St', village: 'Elora', state: 'Ontario' },
  }]);
  assert.strictEqual(village[0].city, 'Elora');

  const muni = dc.parseGeocodeResults([{
    lat: '44.0', lon: '-79.0', display_name: 'X',
    address: { road: 'Main St', municipality: 'Chatham-Kent', state: 'Ontario' },
  }]);
  assert.strictEqual(muni[0].city, 'Chatham-Kent');
});

test('parseGeocodeResults: with no house_number or road, uses the first display_name segment', () => {
  const r = dc.parseGeocodeResults([{
    lat: '43.6', lon: '-79.3', display_name: 'Baycrest Hospital, Bathurst Street, Toronto, Canada',
    address: { city: 'Toronto', state: 'Ontario' },
  }]);
  assert.strictEqual(r[0].address, 'Baycrest Hospital');
});

test('parseGeocodeResults: empty array in, empty array out', () => {
  assert.deepStrictEqual(dc.parseGeocodeResults([]), []);
});

test('parseGeocodeResults: malformed input never throws', () => {
  for (const bad of [null, undefined, 'not json', 42, {}, [null], [{}], [{ lat: 'x', lon: 'y' }]]) {
    assert.deepStrictEqual(dc.parseGeocodeResults(bad), [], `should be [] for ${JSON.stringify(bad)}`);
  }
});

test('parseGeocodeResults: drops entries whose coordinates do not parse', () => {
  const r = dc.parseGeocodeResults([
    { lat: 'nope', lon: '-79.4', display_name: 'bad', address: {} },
    NOMINATIM_FULL[0],
  ]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].city, 'Toronto');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test lib/doc-container.test.js`
Expected: FAIL — `dc.parseGeocodeResults is not a function`.

- [ ] **Step 3: Implement the parser**

Add to `lib/doc-container.js` directly below `haversineKm`:

```js
// Nominatim jsonv2 -> flat fields. This function is the ENTIRE provider-shape
// dependency (spec §3.2): swapping geocoders means rewriting this and its
// fixtures, nothing else. Never throws — a malformed body is simply no results,
// because a parse error must not surface as a UI exception.
function parseGeocodeResults(json) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const lat = formatCoord(item.lat);
    const lon = formatCoord(item.lon);
    if (lat == null || lon == null) continue;      // unusable without a position

    const a = (item.address && typeof item.address === 'object') ? item.address : {};
    const display = typeof item.display_name === 'string' ? item.display_name : '';

    let street = [a.house_number, a.road].filter(Boolean).join(' ').trim();
    if (!street) street = display.split(',')[0].trim();

    out.push({
      display: display || street,
      address: street,
      city: a.city || a.town || a.village || a.municipality || '',
      province: a.state || '',
      postalCode: a.postcode || '',
      lat, lon,
    });
  }
  return out;
}
```

Then add `parseGeocodeResults,` to the `module.exports` object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test lib/doc-container.test.js`
Expected: PASS.

- [ ] **Step 5: Regenerate the inlined core and check syntax**

```bash
node scripts/inline-doc-container.js
node --check main.js
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add lib/doc-container.js lib/doc-container.test.js main.js
git commit -m "feat(geo): pure Nominatim jsonv2 response parser"
```

---

### Task 3: Settings — opt-in, endpoint, country filter

**Files:**
- Modify: `main.js` (`DEFAULT_SETTINGS` at ~line 1341; settings tab `display()`)

**Interfaces:**
- Consumes: nothing.
- Produces: `this.settings.geocodingEnabled` (boolean), `this.settings.geocodingEndpoint` (string), `this.settings.geocodingCountryCodes` (string).

- [ ] **Step 1: Add the three settings defaults**

In `main.js`, add to the `DEFAULT_SETTINGS` object, after the `docRoot: 'Documents',` line:

```js
  // ── Site geolocation (spec 2026-08-03) ──────────────────────────────────
  // OFF by default and deliberately so: this plugin is otherwise
  // network-silent apart from the user-triggered asset download. While this
  // is false the Look up control is NOT RENDERED, so no request is reachable.
  geocodingEnabled: false,
  // Point this at a self-hosted Nominatim for zero third-party egress.
  geocodingEndpoint: 'https://nominatim.openstreetmap.org/search',
  // Comma-separated ISO country codes; blank means unrestricted.
  geocodingCountryCodes: 'ca',
```

- [ ] **Step 2: Add the settings-tab section**

In the settings tab's `display()` method, immediately after the "Re-install assets from zip" `Setting` block, add:

```js
    containerEl.createEl('h3', { text: 'Site geolocation' });

    new obsidian.Setting(containerEl)
      .setName('Enable address lookup')
      .setDesc(
        'Adds a "Look up" button to the address field on Site and Organization records. ' +
        'When you press it, the address you typed is sent to the endpoint below so it can be ' +
        'resolved to coordinates. Nothing is sent while you type, and nothing else in the ' +
        'record is ever transmitted. Off by default.'
      )
      .addToggle(t => t
        .setValue(!!this.plugin.settings.geocodingEnabled)
        .onChange(async v => {
          this.plugin.settings.geocodingEnabled = v;
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Geocoding endpoint')
      .setDesc(
        'Nominatim-compatible search endpoint. Point this at a self-hosted Nominatim if you ' +
        'do not want addresses leaving your network.'
      )
      .addText(t => t
        .setPlaceholder('https://nominatim.openstreetmap.org/search')
        .setValue(this.plugin.settings.geocodingEndpoint || '')
        .onChange(async v => {
          this.plugin.settings.geocodingEndpoint = v.trim();
          await this.plugin.saveSettings();
        }));

    new obsidian.Setting(containerEl)
      .setName('Limit results to countries')
      .setDesc('Comma-separated ISO country codes, e.g. "ca". Leave blank to search worldwide.')
      .addText(t => t
        .setPlaceholder('ca')
        .setValue(this.plugin.settings.geocodingCountryCodes || '')
        .onChange(async v => {
          this.plugin.settings.geocodingCountryCodes = v.trim();
          await this.plugin.saveSettings();
        }));
```

The description text is a requirement, not decoration: a user must be able to learn what enabling this does without reading the spec.

- [ ] **Step 3: Verify syntax and defaults**

```bash
node --check main.js
node -e "const s=require('fs').readFileSync('main.js','utf8'); for (const k of ['geocodingEnabled','geocodingEndpoint','geocodingCountryCodes']) { if (!s.includes(k)) { console.error('MISSING '+k); process.exit(1); } } console.log('all three settings present');"
```
Expected: `all three settings present`.

- [ ] **Step 4: Manual check**

Reload Obsidian, open the plugin settings tab. Expected: a "Site geolocation" heading with a toggle (off) and two text fields pre-filled with the Nominatim URL and `ca`.

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(geo): opt-in geocoding settings, default off"
```

---

### Task 4: The network seam — `geocodeAddress()`

**Files:**
- Modify: `main.js` (new plugin method, placed next to `_awaitBacklink`)

**Interfaces:**
- Consumes: `docContainer.parseGeocodeResults` (Task 2); settings (Task 3).
- Produces: `async geocodeAddress(query)` → `{ ok: true, results: [...] } | { ok: false, reason: 'disabled'|'empty'|'network' }`.
  **The only function in the codebase that performs a geocoding request.**

- [ ] **Step 1: Implement**

Add to the plugin class in `main.js`, directly after the `_awaitBacklink` method:

```js
  // The ONLY function that performs a geocoding request. Callers must invoke it
  // from an explicit user gesture — never from render, input, focus or save
  // (spec §4). Returns a discriminated result rather than throwing, so every
  // caller is forced to handle failure.
  async geocodeAddress(query) {
    if (!this.settings.geocodingEnabled) return { ok: false, reason: 'disabled' };
    const q = String(query || '').trim();
    if (!q) return { ok: false, reason: 'empty' };

    const base = (this.settings.geocodingEndpoint || 'https://nominatim.openstreetmap.org/search').trim();
    const cc = (this.settings.geocodingCountryCodes || '').trim();
    const params = [
      'q=' + encodeURIComponent(q),
      'format=jsonv2',
      'addressdetails=1',
      'limit=5',
    ];
    if (cc) params.push('countrycodes=' + encodeURIComponent(cc));
    const url = base + (base.includes('?') ? '&' : '?') + params.join('&');

    try {
      const version = (this.manifest && this.manifest.version) || '0.0.0';
      const res = await obsidian.requestUrl({
        url,
        method: 'GET',
        headers: {
          // Nominatim's policy rejects stock library user-agents outright.
          'User-Agent': 'obsidi-office/' + version + ' (Obsidian plugin)',
          'Accept': 'application/json',
        },
        throw: false,
      });
      if (!res || res.status < 200 || res.status >= 300) {
        elog('[geo] lookup HTTP', res && res.status);
        return { ok: false, reason: 'network' };
      }
      let body = res.json;
      if (body == null) { try { body = JSON.parse(res.text); } catch (e) { body = null; } }
      return { ok: true, results: docContainer.parseGeocodeResults(body) };
    } catch (e) {
      elog('[geo] lookup failed:', (e && e.stack) || e);
      return { ok: false, reason: 'network' };
    }
  }
```

`throw: false` matters — without it `requestUrl` throws on non-2xx and the status is lost.

- [ ] **Step 2: Verify syntax and the definition/call invariant**

```bash
node --check main.js
node -e "const s=require('fs').readFileSync('main.js','utf8'); const d=(s.match(/^  async geocodeAddress\(/gm)||[]).length; console.log('geocodeAddress defined:', d); process.exit(d===1?0:1);"
```
Expected: `geocodeAddress defined: 1`.

This check exists because a previous edit in this codebase deleted a method while leaving three call sites, shipping a `TypeError`.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(geo): geocodeAddress — the single network seam, gated on the setting"
```

---

### Task 5: The candidate picker

**Files:**
- Modify: `main.js` (new `GeocodePickerModal` class, placed directly before `class EntityCreateModal`)

**Interfaces:**
- Consumes: result objects from `parseGeocodeResults` (Task 2).
- Produces: `new GeocodePickerModal(app, results, onPick).open()`. `onPick(result)` fires only on an explicit selection; dismissing calls nothing.

- [ ] **Step 1: Implement**

Add to `main.js` immediately above `class EntityCreateModal`:

```js
// Candidate list for an address lookup. Selection is ALWAYS explicit — there is
// deliberately no auto-pick when results.length === 1, because a single
// confident-looking wrong answer is the failure most likely to go unnoticed
// (spec §6).
class GeocodePickerModal extends obsidian.Modal {
  constructor(app, results, onPick) { super(app); this.results = results || []; this.onPick = onPick; }
  onOpen() {
    this.titleEl.setText('Select the matching address');
    const c = this.contentEl;
    c.createDiv({
      cls: 'doc-detail-stub',
      text: this.results.length + (this.results.length === 1 ? ' match found.' : ' matches found.')
        + ' Nothing is changed until you choose one.',
    });
    const list = c.createDiv('doc-ent-geolist');
    this.results.forEach((r) => {
      const row = list.createEl('button', { cls: 'doc-ent-georow' });
      row.createDiv({ text: r.display, cls: 'doc-ent-geoname' });
      row.createDiv({ text: r.lat + ', ' + r.lon, cls: 'doc-ent-geocoord' });
      row.setAttr('aria-label', 'Use ' + r.display);
      row.onclick = () => { this.close(); if (this.onPick) this.onPick(r); };
    });
    const bar = c.createDiv('doc-detail-sh-bar');
    bar.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
  }
  onClose() { this.contentEl.empty(); }
}
```

- [ ] **Step 2: Add the styles**

`styles.css` does not exist for this plugin — CSS lives in the template string inside `main.js`. Find the `.doc-ent-sample-banner` rule (around line 900) and add directly after the `.doc-ent-sample th` rule:

```css
.doc-ent-geolist { display:flex; flex-direction:column; gap:6px; margin:12px 0; }
.doc-ent-georow.doc-ent-georow {
  display:block; width:100%; text-align:left; height:auto; min-height:0;
  white-space:normal; padding:8px 10px; cursor:pointer;
  background-color: var(--background-secondary); box-shadow:none;
  border:1px solid var(--background-modifier-border); border-radius:6px;
}
.doc-ent-georow.doc-ent-georow:hover { background-color: var(--background-modifier-hover); }
.doc-ent-geoname  { color: var(--text-normal); }
.doc-ent-geocoord { color: var(--text-muted); font-size:0.85em; margin-top:2px; }
```

Two deliberate details, both from `meta/lessons.md`:
- The class is **repeated** (`.doc-ent-georow.doc-ent-georow`) to reach specificity (0,2,0), which beats Obsidian's `button:not(.clickable-icon)` at (0,1,1). That rule sets `color`, `background-color` and `box-shadow`, and it is why an unstyled plugin button renders as a box.
- `height:auto; min-height:0; white-space:normal` are required because Obsidian's bare `button` rule sets `height: var(--input-height)` (~30px) with `nowrap`. These rows are two lines, so without this they clamp and overlap the next row.

- [ ] **Step 3: Verify syntax**

```bash
node --check main.js
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(geo): candidate picker modal, explicit selection only"
```

---

### Task 6: Wire Look up into entity edit mode

**Files:**
- Modify: `main.js` (`_entCell` in `ContainerOverviewView`)

**Interfaces:**
- Consumes: `geocodeAddress` (Task 4), `GeocodePickerModal` (Task 5), `this._entInputs` (existing).
- Produces: a Look up button beside the address input while editing a Site or Organization record.

**Key seam:** `_saveEntityEdits` already persists by walking `this._entInputs` and comparing each `inp.value` against `orig`. The picker only needs to set `.value` on those inputs — no new save path.

- [ ] **Step 1: Implement**

In `_entCell`, inside the `if (editing) { ... }` branch. The insertion point is between these two
existing lines — the closing brace of the `else` block that creates plain inputs, and the line that
registers the input:

```js
        if (f.type === 'entity') inp.placeholder = 'Organization name';
      }
      // <<< INSERT THE BLOCK BELOW HERE >>>
      this._entInputs[f.key] = { inp, orig: seed, field: f };
      return;
```

Add:

```js
      // Look up: only for the address field, only while editing, and only when the
      // setting is on. When off the control is ABSENT, not disabled (spec §4).
      if (f.key === 'address' && this.plugin.settings.geocodingEnabled) {
        const btn = cell.createEl('button', { text: 'Look up', cls: 'doc-ent-geobtn' });
        btn.type = 'button';
        btn.onclick = async () => {
          const q = inp.value.trim();
          if (!q) { new obsidian.Notice('Type an address first.'); return; }
          btn.disabled = true; btn.setText('Looking up…');
          const res = await this.plugin.geocodeAddress(q);
          btn.disabled = false; btn.setText('Look up');
          if (!res.ok) {
            new obsidian.Notice(res.reason === 'network'
              ? 'Address lookup failed. Check your connection, or enter coordinates manually.'
              : 'Address lookup is unavailable.');
            return;
          }
          if (!res.results.length) {
            new obsidian.Notice('No match found. Try a simpler address, or enter coordinates manually.');
            return;
          }
          new GeocodePickerModal(this.app, res.results, (pick) => this._applyGeocode(pick)).open();
        };
      }
```

Then add this method to `ContainerOverviewView`, directly after `_entCell`:

```js
  // Write a picked result into the open edit form. Only fields the response
  // actually carries are touched — a partial match must never blank data the
  // user already typed (spec §6). _saveEntityEdits persists from these inputs.
  _applyGeocode(pick) {
    const inputs = this._entInputs || {};
    const set = (key, val) => {
      if (!val) return;                       // absent component -> leave as-is
      if (!inputs[key] || !inputs[key].inp) return;   // field not on this record type
      inputs[key].inp.value = val;
    };
    set('address', pick.address);
    set('city', pick.city);
    set('province', pick.province);
    set('postalCode', pick.postalCode);
    set('lat', pick.lat);
    set('lon', pick.lon);
    set('geocodedAt', new Date().toISOString().slice(0, 10));
    set('geocodeSource', 'nominatim');
    new obsidian.Notice('Address filled. Review it, then Save changes.');
  }
```

An Organization record has no `lat`/`lon`/`geocodedAt`/`geocodeSource` fields, so those `set` calls no-op via the `inputs[key]` guard. That is why Organization support costs nothing extra.

- [ ] **Step 2: Add the button style**

Add to the CSS block next to the picker styles from Task 5:

```css
.doc-ent-geobtn.doc-ent-geobtn {
  margin-top:6px; height:auto; min-height:0; padding:4px 10px;
  background-color: var(--interactive-normal); box-shadow:none;
  border:1px solid var(--background-modifier-border); border-radius:4px;
  cursor:pointer; font-size:0.9em;
}
.doc-ent-geobtn.doc-ent-geobtn:hover { background-color: var(--interactive-hover); }
```

- [ ] **Step 3: Verify syntax and the definition/call invariant**

```bash
node --check main.js
node -e "const s=require('fs').readFileSync('main.js','utf8'); const d=(s.match(/^  _applyGeocode\(/gm)||[]).length; const c=(s.match(/this\._applyGeocode\(/g)||[]).length; console.log('_applyGeocode defined:',d,'called:',c); process.exit(d===1&&c>=1?0:1);"
```
Expected: `_applyGeocode defined: 1 called: 1`.

- [ ] **Step 4: Manual check**

Reload Obsidian. With geocoding **off**, edit a Site record — expected: no Look up button anywhere. Turn it **on**, edit again — expected: the button appears under the address field; typing does not emit any request (watch the Network tab).

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(geo): Look up control in entity edit mode"
```

---

### Task 7: Wire Look up into the New Site modal

**Files:**
- Modify: `main.js` (`EntityCreateModal.onOpen`)

**Interfaces:**
- Consumes: `geocodeAddress` (Task 4), `GeocodePickerModal` (Task 5).
- Produces: the create modal returns `address`, `lat`, `lon`, `geocodedAt` and `geocodeSource` in its `onSubmit` payload; `openNewSiteModal` seeds them onto the new record.

- [ ] **Step 1: Add the button to the modal**

`EntityCreateModal` has no plugin reference, so pass one. In `openNewSiteModal` and in the "New organization" handler in `renderContainers`, add `plugin: this` (in `renderContainers` use `plugin: this.plugin`) to the options object given to `new EntityCreateModal(...)`.

In `EntityCreateModal.onOpen`, directly after the line that creates `addr`:

```js
      // Absent unless geocoding is enabled (spec §4).
      const plugin = this.opts.plugin;
      if (plugin && plugin.settings.geocodingEnabled) {
        const gbtn = c.createEl('button', { text: 'Look up', cls: 'doc-ent-geobtn' });
        gbtn.type = 'button';
        gbtn.onclick = async () => {
          const q = addr.value.trim();
          if (!q) { new obsidian.Notice('Type an address first.'); return; }
          gbtn.disabled = true; gbtn.setText('Looking up…');
          const res = await plugin.geocodeAddress(q);
          gbtn.disabled = false; gbtn.setText('Look up');
          if (!res.ok) {
            new obsidian.Notice(res.reason === 'network'
              ? 'Address lookup failed. Check your connection, or enter coordinates manually.'
              : 'Address lookup is unavailable.');
            return;
          }
          if (!res.results.length) {
            new obsidian.Notice('No match found. Try a simpler address.');
            return;
          }
          new GeocodePickerModal(this.app, res.results, (pick) => {
            addr.value = pick.address || addr.value;
            this._geo = pick;                 // carried into onSubmit below
          }).open();
        };
      }
```

- [ ] **Step 2: Carry the coordinates through submit**

In the same class, replace the `await this.opts.onSubmit({...})` payload with:

```js
      await this.opts.onSubmit({
        name: name.value.trim(),
        orgType: (!isSite && typeSel) ? typeSel.value : '',
        siteType: (isSite && typeSel) ? typeSel.value : '',
        address: addr ? addr.value.trim() : '',
        geo: this._geo || null,
      });
```

- [ ] **Step 3: Seed the coordinates onto the new record**

In `openNewSiteModal`, replace the seed construction with:

```js
      onSubmit: async ({ name, siteType, address, geo }) => {
        const seed = { organization: docContainer.entityLink(orgName) };
        if (siteType) seed.siteType = siteType;
        if (address) seed.address = address;
        if (geo) {
          if (geo.city) seed.city = geo.city;
          if (geo.province) seed.province = geo.province;
          if (geo.postalCode) seed.postalCode = geo.postalCode;
          seed.lat = geo.lat;
          seed.lon = geo.lon;
          seed.geocodedAt = new Date().toISOString().slice(0, 10);
          seed.geocodeSource = 'nominatim';
        }
```

`createEntity` already skips `null`/`''` values when writing frontmatter, so absent components produce absent keys rather than empty strings.

- [ ] **Step 4: Verify syntax**

```bash
node --check main.js
node -e "const s=require('fs').readFileSync('main.js','utf8'); console.log('plugin passed to modal:', (s.match(/plugin: this(\.plugin)?,/g)||[]).length);"
```
Expected: at least 2.

- [ ] **Step 5: Run the full pure-core suite**

```bash
node --test lib/doc-container.test.js
```
Expected: PASS, 89 prior tests + 15 new.

- [ ] **Step 6: Manual end-to-end check**

With geocoding on, create a site from an organization's Sites tab using a real address. Expected: Look up returns matches; picking one fills the address; after Create, the record on disk carries `lat`, `lon`, `geocodedAt`, `geocodeSource`, `city`, `province`, `postalCode`.

```powershell
Get-Content "C:\Obsidian\OB_Testing\Documents\Sites\<new site>\<new site>.md"
```

- [ ] **Step 7: Bump the version and deploy**

```bash
node -e "const f='manifest.json',j=JSON.parse(require('fs').readFileSync(f,'utf8'));const p=j.version.split('.');p[2]=String(+p[2]+1);j.version=p.join('.');require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n');console.log('version',j.version);"
cp main.js manifest.json "/c/Obsidian/OB_Testing/.obsidian/plugins/obsidi-office/"
```

- [ ] **Step 8: Commit**

```bash
git add main.js manifest.json
git commit -m "feat(geo): address lookup in the New Site modal, coordinates seeded on create"
```

---

## Acceptance verification

Map each spec acceptance criterion to its check. Run after Task 7.

| # | Criterion | How to verify |
|---|---|---|
| 1 | No request and no control while disabled | Setting off; edit a site, type an address, watch DevTools Network — zero requests, no button |
| 2 | Request only on explicit press | Setting on; type without pressing — zero requests |
| 3 | Identifying User-Agent, one request per press | Network tab: `obsidi-office/<version>` header, one entry per click |
| 4 | Fills all fields on a Site, address only on an Org | Task 7 step 6, then repeat on an Organization record |
| 5 | Nothing modified without a selection; absent components leave values alone | Open the picker, press Cancel — form unchanged. Then pick a rural address with no postcode — existing postal code survives |
| 6 | `lat`/`lon` editable and persist with geocoding off | Turn setting off, type coordinates by hand, Save, reopen |
| 7 | `haversineKm` correct against a known pair | `node --test lib/doc-container.test.js` (Task 1) |
| 8 | 6 dp, matching P22's `wgs84` shape | Inspect the written frontmatter |
| 9 | Every failure leaves the form unchanged, reports via Notice | Airplane mode; then a nonsense address |
| 10 | Endpoint configurable | Point at an unreachable URL — clean failure Notice, not a crash |

## Self-review notes

- **Spec coverage:** §3.1–3.3 → Task 4. §3.4 → Task 3. §4 → Tasks 3, 6, 7. §5 → Task 1. §6 → Tasks 5, 6, 7. §7 → Tasks 1, 2, 4, 5. §8 → Tasks 4, 6, 7. §9 → no code (documentation only). §10 → Tasks 1, 2 plus the manual list. §11 → the table above.
- **Scope note:** §2 excludes a bulk backfill of existing site records. Sites created before this ships keep their addresses and simply have no coordinates until someone edits them and presses Look up.
- **Ordering:** Tasks 1–2 are pure and independently testable. Tasks 3–5 add inert machinery — nothing is reachable from the UI until Task 6. Task 7 is the second surface. A reviewer can reject any one task without blocking its neighbours.
