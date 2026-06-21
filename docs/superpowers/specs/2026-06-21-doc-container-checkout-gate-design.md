# Doc-Container — Mandatory Check-out Gate + Immutable Version History

**Date:** 2026-06-21
**Branch:** `doc-container`
**Status:** Design — awaiting user review before plan

## Problem

The check-out feature is currently **advisory only**. The detail-page lock bar records who
holds a document, and the kick mechanism (`_enforceCheckoutOnOpenEditors` →
`_promptKick`, `main.js:6974`) drops an open editor to read-only when *someone else* takes
the lock. But nothing requires a user to check a document out before editing it. If nobody
checks out, two authors can edit the same document concurrently and the kick never fires —
there is no lock for it to enforce. The gate is the missing piece that makes the existing
lock + kick machinery reliable.

Separately, prior versions are editable in place today, which both allows history to be
rewritten and produces the stale-lock-on-old-versions residue noted in the workflow
analysis (the lock lives on the per-version sidecar; `clearCheckout` only clears the
current version's sidecar — `main.js:6963`).

## Goals

1. **Editing requires holding the check-out.** A managed document opens read-only; it
   becomes editable only while the current author holds the lock.
2. **Only the current version is editable.** Prior versions are immutable read-only
   history.
3. **The Overview/detail page is the single control surface** for taking and releasing the
   lock. The editor reflects state but never offers check-out itself.
4. **State stays live.** Taking or releasing the lock from the Overview flips an
   already-open editor between read-only and editable without a manual reload.

## Non-goals (explicitly out of scope)

- **Rung B `_document.md` migration apply** — still deferred. The lock continues to live on
  the current-version sidecar via `lockTargetFile`'s fallback (`main.js:6943`). The
  "only current is editable" rule makes the stale-lock residue on old sidecars irrelevant
  (old versions are never edit-gated against their own lock — see §4), so Rung B is not a
  prerequisite for this work.
- **Check-out timeout enforcement** — `checkoutTimeoutHours` stays display-only (`stale`
  flag shown, not enforced). Unchanged.
- **P01_WhiteList identity integration** — author identity remains
  `resolveAuthorId()` → `slugifyAuthor(getUsername())` (`main.js:2073`).
- **Force check-in policy** — stays open to any author via the existing two-click confirm
  (`main.js:3468`). Unchanged.

## Scope constraint (critical)

The gate applies **only to doc-container-managed documents** — i.e. when
`settings.docBrowserEnabled` is on AND the file lives under `settings.docRoot` AND it is a
recognized version file of a document folder. Regular `.docx`/`.pptx`/`.xlsx`/`.pdf` files
opened outside the doc-container system must keep today's freely-editable behavior. The
gate must never make an ordinary office document read-only.

## Design

### 1. Editing gate (editor)

`_buildEditorConfig` (`main.js:3056`) today computes `lockedOut = docBrowserEnabled &&
_isLockedByOther(file)` and uses it to disable `edit`/`comment` and force `mode:"view"`
(`3071`, `3077`). The gate inverts the default: a managed document is editable **only when
the current author holds the lock on the current version**.

Introduce a single predicate the config consumes:

```
_editGate(file) → { managed, current, heldByMe, heldByOther, editable, holder }
```

- `managed` = `docBrowserEnabled` && file under `docRoot` && file parses as a version file
  whose folder is a document (reuse `parseVersion` `main.js:90` / `groupDocumentFiles`
  `main.js:112`).
- `current` = file is the highest version in its folder (`groupDocumentFiles().current`).
- `heldByMe` / `heldByOther` from the file's lock sidecar via the same read
  `_isLockedByOther` uses (`main.js:3045-3049`), comparing `lockStateFromFront().by` to
  `resolveAuthorId()`.
- `editable` = `managed ? (current && heldByMe) : true`  ← non-managed files stay editable.

`_buildEditorConfig` then sets `mode`/`edit`/`comment` from `editable` instead of
`!lockedOut`. `_isLockedByOther` is retained unchanged for the kick path.

Resulting states for a managed document:

| Lock state | Current version | Old version |
|---|---|---|
| Unlocked | read-only | read-only |
| Held by me | **editable** | read-only |
| Held by other | read-only (+ kick) | read-only |

### 2. Read-only banner (editor, bottom status strip)

A state-aware banner sits at the **bottom of the editor**, overlaying the empty region of
the OnlyOffice status bar (between "Word count" and the language selector). It is a sibling
of the existing Return-to-Overview overlay button and is built the same way: a
`_syncEditGateBanner()` method called from `onLoadFile` right after `_onLoadFileInner`
(mirroring `_syncReturnAction`, `main.js:2469` / `2502`), re-created on every load so a
re-render cannot orphan it, removed/replaced when state changes.

Banner copy by state (managed docs only; no banner for non-managed files):

- **Read-only, unlocked:** "Read-only — check out from the Overview to edit."
- **Read-only, held by other:** "Read-only — checked out by `{holder}`."
- **Read-only, old version:** "Read-only — prior version (history)."
- **Editable, held by me:** subtle confirmation "Checked out by you" (or no banner — see
  open question O1).

The banner is informational; it offers no check-out action (control is Overview-only,
reachable via the Return-to-Overview button). Exact pixel seating in the status strip is a
tuning detail handled the same way as the Return button (`bottom`/`left` nudge), styled via
a `.doc-editgate-banner` CSS class in `DOC_CONTAINER_CSS` (`main.js:585`).

### 3. Check-out control (detail page only)

No change to the lock bar (`main.js:3456`): Check out / Check in / Force check-in remain the
only place the lock is taken or released. The canonical loop:

Overview → **Check out** → Open in editor (opens editable) → edit → Return to Overview →
**Check in**.

### 4. Version model

- **Only the current version is checkoutable/editable.** Prior versions always open
  read-only (enforced in `_editGate` via the `current` test, §1). Because an old version is
  read-only by rule *before* its own lock is consulted for editing, the stale lock keys left
  on superseded sidecars become inert — neutralizing the residue without a migration.
- **Files & Versions tab** (`main.js:3598`): current row keeps "Open in editor" and is the
  only row reflecting live lock state; prior-version rows open read-only (their "Open"
  button already routes through `openDocInEditor`, which will now open them read-only via the
  gate). Old rows get a clarifying affordance (e.g. badge tooltip "read-only history").
- **New-version guard:** `newDocumentVersion` (`main.js:7301`) gains a precondition — if the
  document is checked out by **another** author (`readLock(node).by &&
  readLock(node).by !== resolveAuthorId()`), block with a Notice ("Checked out by
  `{holder}` — cannot create a new version"). Allowed when free or held by you.
- **Lock carry-forward is retained.** The verbatim sidecar copy (`main.js:7319-7322`) stays:
  when the lock holder bumps a version, the new current inherits their lock so editing
  continues seamlessly, and the kick guarantee still has a lock on the new current to
  enforce. (This is why we are NOT stripping `checkedOutBy`/`checkedOutAt` on copy.)

### 5. Live state propagation

`_enforceCheckoutOnOpenEditors` (`main.js:6974`), already wired to vault + metadataCache
events (`main.js:5780-5790`), is extended from "kick when newly locked-by-other" to
"reconcile every open managed editor whenever its edit-gate result changes":

- Track the last computed gate per view (e.g. `view._gateEditable`).
- On a lock transition where `_editGate(file).editable` differs from the tracked value,
  reload the view (`view.onLoadFile(file)` with `_suppressEditLogReset = true`, as
  `_promptKick` already does, `main.js:6998`) so `_buildEditorConfig` recomputes and the
  banner updates. This covers: you check out → editor becomes editable; you check in →
  editor becomes read-only; other releases → stays read-only but banner clears holder name.
- The kick **modal** (`_promptKick`, save-a-copy fork offer) still fires specifically for
  the transition "you could edit → now locked by other" (someone grabbed it mid-edit),
  gated by the existing `view._kicked` flag so it does not re-prompt.

## Edge cases

- **Non-managed office files:** `_editGate.editable` is `true` → unchanged editable
  behavior; no banner.
- **`docBrowserEnabled` off:** entire gate is inert; today's behavior.
- **Opening an old version while you hold the current's lock:** old version still opens
  read-only (current-version test wins).
- **Check in from Overview while your editor is open:** §5 reload flips it to read-only.
- **Force check-in by another while you hold it and are editing:** existing kick path fires
  (modal + fork offer + read-only reload).
- **A document with a single bare file (no `_V1.0` suffix):** `groupDocumentFiles` treats it
  as `current`; gate applies normally.

## Affected code (all in `main.js`)

| Area | Location | Change |
|---|---|---|
| Edit-gate predicate | new method on `OfficeEditorView` | add `_editGate(file)` |
| Editor config | `3056`, `3071`, `3077` | drive mode/edit/comment from `_editGate().editable` |
| Read-only banner | new `_syncEditGateBanner()` + call site `2502` | bottom status-strip overlay |
| Banner CSS | `DOC_CONTAINER_CSS` `585` | `.doc-editgate-banner` rules |
| New-version guard | `7301` | block when held by another |
| Live propagation | `6974` | reconcile editable transitions, not just kicks |
| Files & Versions affordance | `3598` | old-row "read-only history" hint |

`_isLockedByOther` (`3041`), `lockTargetFile` (`6943`), `readLock`/`setCheckout`/
`clearCheckout` (`6951`-`6968`), the detail lock bar (`3456`), and `saveForkCopy` (`7003`)
are unchanged.

## Testing

Pure-core (node `--test`, no Obsidian): version/current detection already covered by
`parseVersion`/`groupDocumentFiles` tests; add cases asserting `_editGate`'s pure decision
table (managed × current × lock-holder → editable) by extracting the decision into a pure
helper in `lib/doc-container.js` that `_editGate` wraps (keeps the plugin-scope method thin).

Smoke (desktop + iPad), gated on real `docRoot`:
1. Open current version without checking out → read-only + correct banner.
2. Check out on Overview → open in editor → editable; banner shows "Checked out by you".
3. Check in on Overview while editor open → editor flips read-only (no manual reload).
4. Open a prior version → always read-only, "prior version" banner.
5. Second author holds lock → your open editor read-only; their force check-in mid-edit →
   kick modal + fork offer.
6. New-version guard: attempt new version while another holds lock → blocked Notice; while
   you hold it → succeeds, new current stays editable by you.
7. Regression: a plain `.docx` outside `docRoot` opens editable with no banner.

## Open questions

- **O1:** When you hold the lock (editable), show a subtle "Checked out by you" banner, or
  no banner at all (banner reserved for read-only states)? Leaning: show it, muted, so the
  editor always communicates lock state.
- **O2:** Banner exact placement — centered in the status strip vs left-aligned after "Word
  count". Resolve during smoke tuning (same as the Return button).
