// ==UserScript==
// @name         Wayfarer Email Importer
// @namespace    https://github.com/Frankmans/OPRplugin
// @version      2.0.1
// @description  Imports Niantic Wayfarer/Spatial/OPR .eml files using a port of bilde2910/OPR-Tools' email parser, and stores them for the Spatial Nominations Panel script to search.
// @author       you
// @match        https://wayfarer.nianticlabs.com/*
// @grant        none
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/opr-email-lib.js
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wst-business-logic.js
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wst-storage.js
// @run-at       document-idle
// ==/UserScript==

/*
 * Companion to wayfarer-spatial-nominations-panel.user.js. This script's
 * ONLY job is getting your raw emails off Gmail (as exported .eml files) and
 * into the shared IndexedDB store ("wst_email_store", see wst-storage.js) as
 * parsed-but-unclassified records -- headers + body, nothing more. It does
 * NOT try to figure out what kind of email something is, match decisions to
 * nominations, or build a submissions list -- that's the panel script's job
 * (wst-business-logic.js), which is a direct port of the old
 * gmail_wayspot_export.py's parsing/matching logic.
 *
 * Splitting it this way means re-running the "search" after fixing a parsing
 * bug is just re-opening the panel -- it doesn't require re-importing every
 * email again, since the raw data is already sitting in IndexedDB.
 *
 * HOW TO GET .eml FILES OUT OF GMAIL:
 * Open a message -> the vertical "..." (More) menu in the top-right of the
 * reading pane -> "Download message". Gmail doesn't support bulk .eml
 * export natively; for a first-time bulk import of years of history,
 * consider Google Takeout (exports Mail as a single .mbox file) plus a
 * local mbox-to-eml splitter, then drop the resulting .eml files in here.
 *
 * SETUP NOTE ON THE @require LINES ABOVE: Tampermonkey needs
 * "Allow access to file URLs" enabled for the extension (in your browser's
 * extension settings) for file:/// @require to work, and the path has to be
 * absolute on your own machine -- update PATH/TO above after saving
 * opr-email-lib.js and wst-storage.js somewhere. If you'd rather not deal
 * with local file permissions, host both files somewhere with a raw URL
 * (a GitHub Gist works well) and point @require at that URL instead --
 * Tampermonkey will then keep them cached and check for updates itself.
 */

(function () {
  'use strict';

  const STYLE = `
    #wei-btn{
      position:fixed; bottom:20px; right:20px; z-index:9999;
      background:#0a0e0c; color:#00e08a; border:1px solid #00e08a;
      font-family:monospace; font-size:13px; padding:10px 16px; border-radius:6px;
      cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,.4);
    }
    #wei-btn:hover{ background:#10160f; }
    #wei-panel{
      position:fixed; bottom:70px; right:20px; z-index:9999;
      background:#0a0e0c; color:#d7f5e6; border:1px solid #223026; border-radius:8px;
      font-family:monospace; font-size:12.5px; padding:16px; width:400px; max-height:75vh;
      overflow-y:auto; box-shadow:0 8px 24px rgba(0,0,0,.5); display:none;
    }
    #wei-panel.open{ display:block; }
    #wei-panel h3{ margin:0 0 4px; font-size:14px; color:#d7f5e6; }
    #wei-panel .wei-sub{ font-size:11px; color:#6b8579; margin-bottom:10px; }
    #wei-dropzone{
      border:2px dashed #223026; border-radius:6px; padding:24px 10px; text-align:center;
      color:#6b8579; margin-bottom:10px; cursor:pointer;
    }
    #wei-dropzone.drag{ border-color:#00e08a; color:#00e08a; }
    #wei-panel button{
      background:#161d19; color:#d7f5e6; border:1px solid #223026; border-radius:4px;
      padding:6px 10px; cursor:pointer; font-family:monospace; font-size:11.5px; margin-right:6px; margin-top:6px;
    }
    #wei-panel button.danger{ color:#ff5d5d; border-color:#ff5d5d; }
    #wei-log{
      margin-top:10px; max-height:260px; overflow-y:auto; font-size:11px; line-height:1.5;
    }
    #wei-log div.ok{ color:#00e08a; }
    #wei-log div.skip{ color:#6b8579; }
    #wei-log div.err{ color:#ff5d5d; }
  `;

  function injectUI() {
    if (document.getElementById('wei-btn')) return;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'wei-btn';
    btn.textContent = '📥 Import Emails';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'wei-panel';
    panel.innerHTML = `
      <h3>Wayfarer Email Importer</h3>
      <div class="wei-sub" id="wei-count">Loading...</div>
      <div id="wei-dropzone">Drop .eml files here, or click to choose</div>
      <input type="file" id="wei-file-input" accept=".eml" multiple style="display:none;">
      <div>
        <button id="wei-export">Export backup JSON</button>
        <button id="wei-import-backup">Import backup JSON</button>
        <input type="file" id="wei-backup-input" accept=".json,application/json" style="display:none;">
        <button id="wei-clear" class="danger">Clear all stored emails</button>
        <button id="wei-close">Close</button>
      </div>
      <div id="wei-log"></div>
    `;
    document.body.appendChild(panel);

    const dropzone = panel.querySelector('#wei-dropzone');
    const fileInput = panel.querySelector('#wei-file-input');
    const backupInput = panel.querySelector('#wei-backup-input');
    const logEl = panel.querySelector('#wei-log');
    const countEl = panel.querySelector('#wei-count');

    function log(msg, cls) {
      const div = document.createElement('div');
      div.className = cls || '';
      div.textContent = msg;
      logEl.prepend(div);
    }

    async function refreshCount() {
      try {
        const n = await WSTStorage.countEmails();
        countEl.textContent = `${n} email(s) stored. Open the Spatial Nominations Panel to search them.`;
      } catch (e) {
        countEl.textContent = 'Could not read the email store.';
      }
    }

    // Normalizes line endings to CRLF (per RFC 5322) regardless of how the
    // .eml was saved -- parseMIME() looks for a literal "\r\n\r\n" boundary.
    function normalizeEml(text) {
      return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    }

    async function importFiles(files) {
      const records = [];
      let parseErrors = 0, ignored = 0;
      for (const file of files) {
        let text;
        try {
          text = await file.text();
        } catch (e) {
          log(`✗ ${file.name}: could not read file`, 'err');
          parseErrors++;
          continue;
        }
        try {
          const email = OPREmail.parseMIME(normalizeEml(text));
          const messageId = email.getFirstHeaderValue('Message-ID', null);
          const id = messageId || `synthetic:${file.name}:${file.size}`;
          records.push({
            id,
            filename: file.name,
            ts: Date.now(),
            headers: email.headers,
            body: email.body,
          });
        } catch (e) {
          log(`✗ ${file.name}: ${e.message || e}`, 'err');
          parseErrors++;
        }
      }

      if (records.length) {
        const { inserted, updated } = await WSTStorage.putEmails(records);
        log(`✓ Imported ${records.length} file(s): ${inserted} new, ${updated} updated`, 'ok');
      }
      if (parseErrors) log(`${parseErrors} file(s) could not be parsed as MIME email`, 'err');
      await refreshCount();
    }

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      const files = Array.from(e.dataTransfer.files).filter((f) => f.name.toLowerCase().endsWith('.eml'));
      if (files.length) importFiles(files);
      else log('No .eml files found in the drop', 'skip');
    });
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files);
      fileInput.value = '';
      if (files.length) importFiles(files);
    });

    panel.querySelector('#wei-export').addEventListener('click', async () => {
      const all = await WSTStorage.getAllEmails();
      const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), emails: all })], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `wst-email-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      log(`Exported ${all.length} email(s) to a backup file`, 'ok');
    });

    panel.querySelector('#wei-import-backup').addEventListener('click', () => backupInput.click());
    backupInput.addEventListener('change', async () => {
      const file = backupInput.files[0];
      backupInput.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const emails = Array.isArray(parsed) ? parsed : parsed.emails;
        if (!Array.isArray(emails)) { log('That file doesn\u2019t look like a valid backup', 'err'); return; }
        const { inserted, updated } = await WSTStorage.putEmails(emails);
        log(`✓ Restored backup: ${inserted} new, ${updated} updated`, 'ok');
        await refreshCount();
      } catch (e) {
        log(`Could not read that backup file: ${e.message || e}`, 'err');
      }
    });

    panel.querySelector('#wei-clear').addEventListener('click', async () => {
      if (!confirm('Delete every stored email from this browser? This cannot be undone (export a backup first if unsure).')) return;
      await WSTStorage.clearAll();
      log('All stored emails cleared', 'skip');
      await refreshCount();
    });

    panel.querySelector('#wei-close').addEventListener('click', () => panel.classList.remove('open'));
    btn.addEventListener('click', () => { panel.classList.toggle('open'); if (panel.classList.contains('open')) refreshCount(); });

    refreshCount();
  }

  injectUI();
  setInterval(injectUI, 2000);
})();
