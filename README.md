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
   should see an **Import Emails** button (top-right) and a
   **Submissions** button (bottom-right, on the Nominations page).

### Updating after a change

`@require`d files (the three library files) get re-fetched by Tampermonkey
on its own schedule, but the userscripts' own bodies do **not**
auto-update just because the file changed on GitHub -- you installed a
local copy. To pick up a change to either `.user.js` file: open its raw URL
again and let Tampermonkey re-prompt, or open it in the Tampermonkey
dashboard editor and paste the new content over the old, then bump the
`@version` line so Tampermonkey knows to re-check the `@require`s too.

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

## Architecture notes

- **Only current-era ("Spatial") submissions are shown in the panel.**
  Legacy Wayfarer- and OPR-era nominations are still parsed and stored (so
  matching/dedup logic that spans eras -- like a Spatial decision for a
  portal originally nominated years ago -- still works correctly), but
  they're filtered out of the display since they're already visible in
  Wayfarer's own contributions page.
- **A handful of subject-line templates are best-effort.** OPR-Tools'
  upstream classification templates don't cover every current-era ("Spatial")
  email type -- some (decided nominations, decided photos, Spatial-branded
  appeals) were reverse-engineered from real inbox testing and are called
  out with comments in `opr-email-lib.js`. One (the decided-appeal subject)
  was never confirmed against a real example and may not match.
- **Content extraction is English-only**, matching the original Python
  script's scope. Classification itself (figuring out *what kind* of email
  something is) works across every language OPR-Tools supports, but pulling
  out the actual portal name/description/coordinates from the body only has
  parsers for the English templates. A non-English email will still get
  stored and classified, but may show up with blank/partial details in the
  panel.

## Credits

Email parsing/classification logic ported from
[bilde2910/OPR-Tools](https://github.com/bilde2910/OPR-Tools)'s
`src/email` module. Matching/business logic ported from an earlier
Python + Gmail API version of this same tracker.
