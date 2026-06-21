# Smoke Test — Mandatory Check-out Gate (doc-container)

**Build under test:** `doc-container` HEAD `bedfb93` (deployed to OB_Testing, byte-identical).
**Plan:** `docs/superpowers/plans/2026-06-21-doc-container-checkout-gate.md`
**Run on:** Desktop first, then iPad (after Obsidian Sync propagates `main.js`).

## Prerequisites (already true in OB_Testing — just confirm)

- Settings → Obsidi-Office: **Document browser ENABLED**, **Doc root = `Documents`**, **Default mode = edit**, **Author label = (empty)** → your identity is your OS username, slugified.
- **Reload the plugin** (or restart Obsidian) so `bedfb93` is live.
- **Primary test document:** `Documents/Governance/Policies/Fan-Out Policy/` — has 3 versions: `FanOutPolicy_V1.0.docx`, `_V1.1.docx`, `_V2.0.docx` (**V2.0 = current**).
- **Regression doc:** any `.docx` that is NOT under `Documents/` (create a throwaway one at the vault root if needed).

## Second-author simulation (for the "held by other" + kick rows)

You hold the lock as your real username. To make a doc appear **checked out by someone else**:
1. Settings → set **Author label = `Other Person`** → check out Fan-Out Policy from its Overview (lock is now stamped `other-person`).
2. Settings → set **Author label back to empty** (you are your real self again).
3. Fan-Out Policy now reads as **held by another author** from your perspective.
To clear afterward: set Author label = `Other Person`, Check in (or Force check-in as yourself), then clear the label.

---

## Checklist

| # | Step | Expected | Pass? |
|---|------|----------|-------|
| 1 | **Read-only by default.** Ensure Fan-Out Policy is NOT checked out. Overview → Files & Versions → **Open in editor** on V2.0 (current). | Editor opens **read-only** (cannot type). Centered bottom banner (red): **"Read-only — check out from the Overview to edit."** | |
| 2 | **Check out → editable.** Return to Overview → **Check out** → Open in editor (V2.0). | Editor is **editable** (can type + save). Banner is **muted**: **"Checked out by you."** | |
| 3 | **Live check-in flips editor.** With that editor tab still open, go to the Overview → **Check in**. | The open editor flips to **read-only automatically** (no manual reload); banner returns to the "check out from the Overview" message. | |
| 4 | **Prior versions are read-only history.** Overview → Files & Versions → **Open** on V1.0 (and V1.1). Hover the **Open** button first. | Tooltip: *"Opens read-only — prior version (history)"*. Editor opens **read-only**; banner: **"Read-only — prior version (history)."** True even if you currently hold the lock. | |
| 5 | **Held by other + kick.** Use the second-author method to make Fan-Out Policy held by `other-person`. (a) Open V2.0 → read-only, banner names the holder: **"Read-only — checked out by other-person."** (b) Then, while a doc you *were* editing is open, have the lock taken by the other author (set label→other, check out, label→empty) → **kick modal** "Released from edit" appears with **"Save a copy"** (fork) offer; editor goes read-only. | Banner names holder in (a); kick modal + fork offer in (b). After (b), check the doc's `_forks/` folder for the saved copy if you chose Save a copy. | |
| 5b | **Holder releases → banner clears name.** While V2.0 is open showing "checked out by other-person", clear the other's lock (label→other, Check in, label→empty). | Banner updates to **"Read-only — check out from the Overview to edit."** (holder name gone) without manual reload. *(This is the spec §5 fix in `bedfb93`.)* | |
| 6 | **New-version guard.** With Fan-Out Policy held by `other-person` (not you), Overview → Files & Versions → **New version**. Then check it in and try again as the holder/free. | Blocked with Notice: **"Checked out by other-person — cannot create a new version."** When free or held by you → New version **succeeds**, and the new current stays editable by you. | |
| 7 | **Regression — ordinary docx unaffected.** Open a `.docx` that is NOT under `Documents/`. | Opens **editable** as before, with **no banner** and no check-out behavior. | |

---

## Notes / what to watch

- **Banner placement (O2 tuning):** centered in the bottom status strip. If it overlaps "Word count" or the language selector at your window width/zoom, note it — vertical/`max-width` is a quick nudge (it's `pointer-events:none`, so it won't block clicks even if it overlaps).
- The lock currently lives on the **current version's sidecar** (`FanOutPolicy_V2.0.docx.md`) — `_document.md` / Rung B is not built. The "only current editable" rule means old-version stale locks are inert.
- If any row fails, capture the console (the debug drawer) and the exact state; report back and I'll fix before push/merge.
