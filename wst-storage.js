// ===========================================================================
// wst-storage.js
//
// Shared IndexedDB layer for raw imported emails. The importer script writes
// here; the panel script reads from here and does the classifying/matching
// (see wst-business-logic.js). Kept as its own tiny module so the DB schema
// only lives in one place.
//
// Record shape (deliberately close to OPR-Tools' StoredEmail so the two stay
// conceptually compatible, minus the multi-import-run "pids" bookkeeping
// that's specific to the full OPR-Tools app):
//   { id: string (Message-ID, or a synthetic fallback), filename: string,
//     ts: number (import time), headers: Header[], body: string }
//
// Exposes: window.WSTStorage
// ===========================================================================
(function (global) {
  "use strict";

  const DB_NAME = "wst_email_store";
  const DB_VERSION = 1;
  const STORE_NAME = "emails";

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // records: array of { id, filename, ts, headers, body }
  // Overwrites by id (Message-ID), so re-importing the same .eml is harmless.
  async function putEmails(records) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      let inserted = 0, updated = 0;
      let pending = records.length;
      if (pending === 0) { resolve({ inserted: 0, updated: 0 }); return; }
      for (const record of records) {
        const getReq = store.get(record.id);
        getReq.onsuccess = () => {
          if (getReq.result) updated++; else inserted++;
          store.put(record);
        };
      }
      tx.oncomplete = () => resolve({ inserted, updated });
      tx.onerror = () => reject(tx.error);
    });
  }

  function getAllEmails() {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function countEmails() {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function clearAll() {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  global.WSTStorage = { openDB, putEmails, getAllEmails, countEmails, clearAll, DB_NAME, STORE_NAME };
})(window);
