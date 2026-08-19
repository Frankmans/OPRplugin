# OPRplugin

Browser-based tracker for your Niantic Wayspot (Ingress Portal / Pokémon Go
Wayspot) submissions -- nominations, photos, and edits -- read straight out
of Gmail, with no server and no Python script to run.

It's a from-scratch client-side reimplementation of the old
[`gmail_wayspot_export.py`](#credits) workflow, split into two userscripts
sharing three plain-JS library files:

| File | Role |
|---|---|
| `opr-email-lib.js` | Parses raw `.eml`/RFC822 email content and classifies each one by type (nomination/photo/edit, received/decided/appeal) and era. A vanilla-JS port of [bilde2910/OPR-Tools](https://github.com/bilde2910/OPR-Tools)'s `src/email` module. |
| `wst-storage.js` | Shared IndexedDB layer. Stores raw parsed emails (`wst_email_store` DB). |
| `wst-business-logic.js` | The "search" logic: turns a pile of classified emails into a list of submissions, matching received&harr;decided pairs, folding in appeals, and reconciling renamed portals. A function-by-function port of the old Python script's parsing/matching code. |
| `wayfarer-email-importer.user.js` | Userscript. Gets emails **in**: either a direct Gmail sync (OAuth, read-only) or dropping `.eml` files by hand. Writes to IndexedDB via `wst-storage.js`. Does no classification itself. |
| `wayfarer-spatial-nominations-panel.user.js` | Userscript. Reads everything out of IndexedDB, classifies + searches it (`wst-business-logic.js`), and shows current-era ("Spatial") submissions in a panel on the Wayfarer nominations page. |

Why split it this way: the importer's only job is turning your mailbox into
raw stored data. All the parsing/matching logic lives in the panel script
instead, so fixing a matching bug or adding a new email template never
requires re-importing anything -- just hit Refresh.

## Installation

You need [Tampermonkey](https://www.tampermonkey.net/) (or a compatible
userscript manager) installed in your browser.

1. Install both userscripts. Easiest way: open each raw URL below in your
   browser -- Tampermonkey will detect it and offer to install it.
   - `wayfarer-email-importer.user.js`:
     `https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wayfarer-email-importer.user.js`
   - `wayfarer-spatial-nominations-panel.user.js`:
     `https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wayfarer-spatial-nominations-panel.user.js`
2. Both scripts' `@require` lines already point at this repo's raw URLs for
   `opr-email-lib.js` / `wst-storage.js` / `wst-business-logic.js`, so there's
   nothing else to configure there.
3. Visit [wayfarer.nianticlabs.com](https://wayfarer.nianticlabs.com/) -- you
   should see an **Import Emails** button and a **Submissions** button, both
   docked bottom-right on the Nominations page (Submissions sits further
   left so the two never overlap when both are open).

### Updating after a change

Both userscripts ship with `@updateURL`/`@downloadURL` pointed at their own
raw GitHub URL, so Tampermonkey periodically checks on its own and offers
(or silently applies, depending on your Tampermonkey settings) updates when
the `@version` in this repo is newer than what's installed -- pushing a
version-bumped change to `main` is normally enough on its own.

Two things worth knowing:
- `@require`d files (the three library files) are cached separately from
  that version-check cycle. If you only change one of those and don't bump
  either userscript's `@version`, Tampermonkey may take a while to notice.
  When you need it picked up promptly, bump the panel script's `@version`
  even for a no-op change -- that forces a fresh fetch of everything it
  `@require`s.
- After updating, do a **hard refresh** of the Wayfarer page (Ctrl+Shift+R /
  Cmd+Shift+R), not a normal reload -- the `@require` fetch happens at
  page-load time, and a soft reload can still serve a browser-cached copy.

## Two ways to get emails in

### Option A: Connect Gmail (recommended)

Direct, incremental, no manual export step. Needs a one-time Google Cloud
setup -- see [Gmail OAuth setup](#gmail-oauth-setup) below.

Once set up: open the Import Emails panel, paste your OAuth Client ID once
(it's remembered), and click **Sync new emails**. First run pulls
everything matching known Niantic sender addresses; after that, each sync
only fetches what's arrived since the last one (with a 1-day overlap buffer
to be safe). **Force full re-sync** ignores the last-synced marker and
re-fetches your whole matching history -- useful the first time, or if you
ever suspect something was missed.

The Gmail scope requested is `gmail.readonly` -- nothing can be sent,
labeled, or deleted through this integration.

### Option B: Drop `.eml` files

Useful as a fallback (a machine where you don't want to set up OAuth, or
just a handful of one-off messages). In Gmail: open a message -> the **⋮**
menu in the reading pane -> **Download message**. Drag the resulting
`.eml` file(s) onto the dropzone in the Import Emails panel, or click it to
pick files.

For a first-time bulk import of years of history without OAuth, consider
Google Takeout (exports Mail as an `.mbox` file) plus a local
mbox-to-`.eml` splitter script, then drop the results in.

### Backup / restore

The Import Emails panel also has **Export backup JSON** (dumps everything
in the IndexedDB store to a file) and **Import backup JSON** (restores from
one) -- handy for moving to a new browser/profile, or just having a safety
copy before clicking **Clear all stored emails**.

## Using the Submissions panel

- **Status totals.** A row of clickable chips (Total / Pending / Accepted /
  Rejected / Appeal) up top -- click one to filter the list to that status.
  Counts respect the type filter and search box, but not each other, so
  switching between chips doesn't make the other totals jump around.
- **Search, type filter, status filter, sort order.** Search matches portal
  name; the sort dropdown toggles Newest/Oldest first.
- **Days pending.** Every Pending entry shows how long it's been waiting,
  color-tiered (neutral under 30 days, yellow 30-89, red 90+) -- combine
  with the Pending status filter and Oldest-first sort to see what's
  actually worth following up on.
- **Legacy submission linking.** If a Spatial entry has a same-named legacy
  Wayfarer/OPR submission (portal name match), it gets a 🔗 next to its
  name; expand the row to see that history without it cluttering the main
  list.
- **Per-submission notes.** Every row's expanded detail has a "Your note"
  textarea -- type something, click away, it auto-saves (with a brief
  "Saved" flash) and shows a 📝 badge on the collapsed row.
- **Manual review.** Some decisions can't be automatically matched back to
  a submission (most often a renamed portal). These show a ⚠ warning with
  a dropdown + **Resolve** button: either merge the decision into the
  correct existing entry, or confirm it really is a separate submission to
  dismiss the warning. Both choices are remembered.
- **Unmatched-email diagnostics.** If some imported emails didn't match any
  known template, the summary line says so and is clickable -- expands into
  a list of their subject/sender/date, with a **Copy all subject lines**
  button so you can report a gap.

## Gmail OAuth setup

This is a one-time setup in Google Cloud Console, roughly ten minutes, no
coding. It creates a **Web application** OAuth client that only your own
browser session uses -- nothing is deployed anywhere.

1. **Create or pick a Google Cloud project.** Go to
   [console.cloud.google.com](https://console.cloud.google.com), and either
   reuse an existing project or create a new one from the project dropdown
   (top-left).
2. **Enable the Gmail API.** Left sidebar -> *APIs & Services* -> *Library*,
   search "Gmail API", click **Enable**.
3. **Set up Google Auth Platform.** *APIs & Services* -> *Google Auth
   Platform*. Under **Audience**, choose **External** user type (unless
   you're on a Google Workspace account, in which case **Internal** skips
   the test-user step entirely). Fill in an app name and your email as the
   support/contact address.
4. **Add yourself as a test user.** Still under **Audience**, scroll to
   *Test users* -> **Add users**, and add your own Gmail address. This lets
   you use the read-only Gmail scope without going through Google's full
   app-verification process, which is meant for public-facing apps, not a
   personal tool like this one.
5. **Add the Gmail read-only scope.** Go to **Data Access** -> *Add or
   Remove Scopes*, search for `gmail.readonly`
   (`https://www.googleapis.com/auth/gmail.readonly`), select it, save.
6. **Create the OAuth Client ID.** Go to **Clients** -> **Create Client**.
   - Application type: **Web application**
   - Under *Authorized JavaScript origins*, add exactly:
     `https://wayfarer.nianticlabs.com`
     (no trailing slash, no path -- this is the page the userscript runs
     on, and Google checks the request's origin against this list)
   - Leave *Authorized redirect URIs* empty -- the popup-based flow this
     script uses doesn't need one.
   - Click **Create**, then copy the Client ID (looks like
     `1234567890-abc...apps.googleusercontent.com`).
7. **Paste the Client ID** into the Import Emails panel's Gmail section and
   click **Sync new emails**.

**What to expect the first time:** since the app is in Testing mode
(not Google-verified), the consent popup will show an "unverified app"
warning. This is expected for a personal-use OAuth client that hasn't gone
through Google's review -- click through it (Advanced -> Go to
\[app name\] (unsafe) is Google's standard wording for this).

**Token lifetime:** the access token is kept in memory only (never written
to disk) and lasts about an hour. It's re-requested each time you revisit
the Wayfarer page -- usually silently, without another popup, unless it's
been revoked or a long time has passed.

## Testing

There's a `node`-native test suite (no framework dependency) covering the
email-classification library, the matching/business logic, IndexedDB
storage, and the actual shipped panel script driven through a real DOM via
jsdom. A GitHub Actions workflow (`.github/workflows/test.yml`) runs it on
every push/PR to `main`, across Node 20.x and 22.x, plus a syntax check on
every `.js`/`.user.js` file and a grep guard against leftover
`file:///PATH/TO`-style placeholders.

```
npm install
npm test              # run the suite
npm run syntax-check  # node --check every shipped script
```

Several tests are regression tests written directly from real bugs found in
production use -- each has a comment explaining the original failure. None
of them use real personal data; scenarios that came from an actual user
report are reproduced with fictional portal names and email addresses.

## Architecture notes

- **Only current-era ("Spatial") submissions are shown in the panel.**
  Legacy Wayfarer- and OPR-era nominations are still parsed and stored (so
  matching/dedup logic that spans eras -- like a Spatial decision for a
  portal originally nominated years ago -- still works correctly), but
  they're filtered out of the display since they're already visible in
  Wayfarer's own contributions page. When the same portal exists in both
  eras, the Spatial entry links to its legacy history instead of hiding it
  entirely (see "Legacy submission linking" above).
- **Era/source is resolved from the sender's email domain first,**
  falling back to subject-line style classification only when the sender
  is unrecognized. The domain is a much harder signal than a regex match
  against the subject -- Niantic genuinely sends from a different address
  per product surface (`notices@recon.nianticspatial.com` for Spatial,
  `notices@wayfarer.nianticlabs.com` for legacy Wayfarer, etc.), whereas
  style classification can occasionally be ambiguous. This matters
  specifically for same-day cross-era submissions: two independent
  nominations for an identically-named portal, one via each era, are kept
  as fully separate entries rather than one silently overwriting the other.
- **A handful of subject-line templates are best-effort or entirely
  supplemental.** OPR-Tools' upstream classification templates don't cover
  every current-era ("Spatial") email type, and have no Dutch appeal
  templates at all -- several (decided nominations, decided photos,
  Spatial-branded appeals, Dutch legacy Wayfarer appeals) were
  reverse-engineered from real inbox testing and are called out with
  comments in `opr-email-lib.js`. One (the Spatial decided-appeal subject)
  was never confirmed against a real example and may not match.
- **Status detection (Accepted/Rejected) is keyword-based** and covers
  every real wording variant found so far, including some that don't
  contain the word "accept" at all. When it can't determine an outcome, the
  entry is left as-is with a review note instead of being silently
  skipped -- the goal is to fail visibly, never silently.
- **Niantic-generated subject lines occasionally contain un-decoded HTML
  entities** (a real example: `&apos;` where a real apostrophe should be).
  These are decoded centrally before any portal-name extraction happens.
- **Content extraction is mostly English-only**, matching the original
  Python script's scope, with Dutch support added for the specific legacy
  Wayfarer templates listed above. Classification itself (figuring out
  *what kind* of email something is) works across every language
  OPR-Tools supports, but pulling the actual portal name/description out
  of the body only has parsers for English (and now some Dutch) wording.
  A non-English email in an unsupported language will still get stored and
  classified, but may show up with blank/partial details in the panel.

## Credits

Email parsing/classification logic ported from
[bilde2910/OPR-Tools](https://github.com/bilde2910/OPR-Tools)'s
`src/email` module. Matching/business logic ported from an earlier
Python + Gmail API version of this same tracker.
