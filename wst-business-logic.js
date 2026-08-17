// ===========================================================================
// wst-business-logic.js
//
// This is the "search" logic the panel script runs over classified emails --
// a direct port of gmail_wayspot_export.py's parsing/matching functions.
// Where the Python script dispatched on which Gmail search query found a
// message, this dispatches on the {type, style} pair OPREmail.Email#classify()
// returns. Function names below are annotated with their Python source name
// so the two can be diffed against each other.
//
// Depends on: window.OPREmail (opr-email-lib.js)
// Exposes: window.WST
// ===========================================================================
(function (global) {
  "use strict";
  const { Type, Style } = global.OPREmail;

  // -------------------------------------------------------------------------
  // Shared helpers (python: centered_text_blocks, parse_coordinates, parse_email_date)
  // -------------------------------------------------------------------------

  // python: centered_text_blocks(soup)
  function centeredTextBlocks(doc) {
    if (!doc) return [];
    const blocks = [];
    for (const div of doc.querySelectorAll("div[style]")) {
      const style = div.getAttribute("style") || "";
      if (!style.includes("text-align: center") && !style.includes("text-align:center")) continue;
      const text = (div.textContent || "").trim();
      if (text) blocks.push(text);
    }
    return blocks;
  }

  // python: parse_coordinates(text)
  function parseCoordinates(text) {
    const m = /\(\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*\)/.exec(text || "");
    if (m) return { latitude: m[1], longitude: m[2] };
    return { latitude: null, longitude: null };
  }

  // python: parse_email_date(date_header) -- returns "YYYY-MM-DD" or ""
  function parseEmailDate(dateHeader) {
    if (!dateHeader) return "";
    const d = new Date(dateHeader);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }

  // Shared Accepted/Rejected detection used across nomination/photo/edit/
  // appeal decision emails. English pairs require both words together (the
  // original, deliberately conservative rule -- avoids a stray
  // "congratulations" on something unrelated flipping the result). The
  // Dutch keywords are *best-effort*: not confirmed against a real Dutch
  // decision email body, only inferred from Niantic's known Dutch template
  // vocabulary, so treat a Dutch status result with a little more caution
  // than an English one. They're additive-only, so they can't cause an
  // English email to be misread.
  function detectDecisionStatus(text) {
    const lower = text.toLowerCase();
    if (
      (lower.includes("congratulations") && lower.includes("accept")) ||
      (lower.includes("gefeliciteerd") && (lower.includes("geaccepteerd") || lower.includes("accepteren")))
    ) return "Accepted";
    if (
      lower.includes("not accept") || lower.includes("unfortunately") ||
      lower.includes("niet accepteren") || lower.includes("niet geaccepteerd") || lower.includes("helaas")
    ) return "Rejected";
    return null;
  }

  function photoUrl(doc, altText) {
    if (!doc) return null;
    const img = doc.querySelector(`img[alt="${altText}"]`);
    return img ? img.getAttribute("src") : null;
  }

  function plaintextOf(email) {
    try {
      return email.getBody("text/plain") || "";
    } catch (e) {
      return "";
    }
  }

  function htmlDocOf(email) {
    try {
      return email.getDocument();
    } catch (e) {
      return null;
    }
  }

  function subjectOf(email) {
    return email.getFirstHeaderValue("Subject", "");
  }

  function toTitleCase(s) {
    return s.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.substring(1).toLowerCase());
  }

  // -------------------------------------------------------------------------
  // Parsing -- Nominations
  // (python: parse_nomination_portal_name, parse_nomination_email,
  //  parse_wayfarer_nomination_email, parse_opr_portal_name,
  //  parse_opr_nomination_email)
  // -------------------------------------------------------------------------

  function parseNominationPortalName(subject) {
    const m = /nomination received for (.+?)!?\s*$/i.exec(subject);
    return m ? m[1].trim() : subject.trim();
  }

  // python: parse_nomination_email -- current Spatial/RECON template
  // (separate styled <div> per line, found via centered_text_blocks)
  function parseNominationEmailSpatial(subject, plaintext, doc) {
    const portalName = parseNominationPortalName(subject);
    const submissionPhoto = photoUrl(doc, "Submission Photo");
    const supportingPhoto = photoUrl(doc, "Supporting Photo");
    const { latitude, longitude } = parseCoordinates(plaintext);

    const textBlocks = centeredTextBlocks(doc);
    let submissionText = "", supportingText = "", extraText = [];
    const idx = textBlocks.indexOf(portalName);
    if (idx >= 0) {
      const cleaned = [];
      for (const t of textBlocks.slice(idx + 1)) {
        if (t.startsWith("Your nomination will be reviewed") || t.includes("Recon Criteria")) break;
        cleaned.push(t);
      }
      if (cleaned.length > 0) submissionText = cleaned[0];
      if (cleaned.length > 1) supportingText = cleaned[1];
      if (cleaned.length > 2) extraText = cleaned.slice(2);
    }

    return {
      portal: portalName, submission_text: submissionText, supporting_text: supportingText,
      extra_text: extraText, submission_photo_url: submissionPhoto, supporting_photo_url: supportingPhoto,
      latitude, longitude,
    };
  }

  // python: parse_wayfarer_nomination_email -- legacy WAYFARER template
  // (everything in one HTML cell joined by <br>, so this reads the plaintext
  // body's line structure instead)
  function parseNominationEmailWayfarer(subject, plaintext, doc) {
    const portalName = parseNominationPortalName(subject);
    const submissionPhoto = photoUrl(doc, "Submission Photo");
    const supportingPhoto = photoUrl(doc, "Supporting Photo");
    const { latitude, longitude } = parseCoordinates(plaintext);

    const lines = plaintext.split("\n").map((l) => l.trim());
    let markerIdx = lines.findIndex((l) => l.toLowerCase().includes("what you") && l.toLowerCase().includes("submitted"));

    let submissionText = "", supportingText = "", extraText = [];
    if (markerIdx >= 0) {
      let cleaned = [];
      for (const l of lines.slice(markerIdx + 1)) {
        if (!l) continue;
        if (l.startsWith("Your nomination will be reviewed") || l.includes("Wayfarer Criteria")) break;
        cleaned.push(l);
      }
      if (cleaned.length && cleaned[0].trim().toLowerCase() === portalName.trim().toLowerCase()) {
        cleaned = cleaned.slice(1);
      }
      cleaned = cleaned.filter((l) => !/^\(\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*\)$/.test(l));
      if (cleaned.length > 0) submissionText = cleaned[0];
      if (cleaned.length > 1) supportingText = cleaned[1];
      if (cleaned.length > 2) extraText = cleaned.slice(2);
    }

    return {
      portal: portalName, submission_text: submissionText, supporting_text: supportingText,
      extra_text: extraText, submission_photo_url: submissionPhoto, supporting_photo_url: supportingPhoto,
      latitude, longitude,
    };
  }

  function parseOprPortalName(subject) {
    const m = /Portal submission confirmation:\s*(.+?)\s*$/i.exec(subject);
    return m ? m[1].trim() : subject.trim();
  }

  // python: parse_opr_nomination_email -- legacy OPR/INGRESS template
  function parseNominationEmailOpr(subject, plaintext, doc) {
    const portalName = parseOprPortalName(subject);
    const photo = photoUrl(doc, "Nomination Photo");

    const lines = plaintext.split("\n").map((l) => l.trim());
    const markerIdx = lines.findIndex((l) => l.toLowerCase().includes("nianticops"));

    let submissionText = "";
    if (markerIdx >= 0) {
      let cleaned = lines.slice(markerIdx + 1).filter((l) => l);
      if (cleaned.length && cleaned[0].trim().toLowerCase() === portalName.trim().toLowerCase()) {
        cleaned = cleaned.slice(1);
      }
      if (cleaned.length) submissionText = cleaned[0];
    }

    return {
      portal: portalName, submission_text: submissionText, supporting_text: "",
      extra_text: [], submission_photo_url: photo, supporting_photo_url: null,
      latitude: null, longitude: null,
    };
  }

  // Dispatches a NOMINATION_RECEIVED email to the right parser by style.
  function parseNominationReceived(email, classification) {
    const subject = subjectOf(email);
    const plaintext = plaintextOf(email);
    const doc = htmlDocOf(email);
    if (classification.style === Style.INGRESS) return parseNominationEmailOpr(subject, plaintext, doc);
    if (classification.style === Style.WAYFARER) return parseNominationEmailWayfarer(subject, plaintext, doc);
    // RECON (current Spatial era) and anything else defaults to the
    // current per-line-div template.
    return parseNominationEmailSpatial(subject, plaintext, doc);
  }

  // python: parse_opr_decision -- returns {status, portal}
  function parseOprDecision(subject, plaintext, htmlText) {
    const text = (plaintext + " " + htmlText).toLowerCase();
    let status = null;
    if (text.includes("not to accept") || text.includes("not accept") || text.includes("unfortunately")) {
      status = "Rejected";
    } else if (
      text.includes("eligible portal") || text.includes("excellent work") ||
      text.includes("good work, agent") || text.includes("accepted your submission") ||
      text.includes("portal's key") || text.includes("portal\u2019s key")
    ) {
      status = "Accepted";
    }
    const m = /Portal review complete:\s*(.+?)\s*$/i.exec(subject);
    return { status, portal: m ? m[1].trim() : null };
  }

  // python: parse_nomination_decision -- returns {status, portal}
  function parseNominationDecision(subject, plaintext, doc, htmlText) {
    const text = (plaintext + " " + htmlText).toLowerCase();
    const status = detectDecisionStatus(text);

    let m = /nomination decided for (.+?)!?\s*$/i.exec(subject);
    if (m) return { status, portal: m[1].trim() };

    m = /Decision on you Recon Nomination,\s*(.+?)\s*$/i.exec(subject);
    if (m && m[1].trim()) return { status, portal: m[1].trim() };

    m = /Decision on your? Wayfarer Nomination,\s*(.+?)\s*$/i.exec(subject);
    if (m && m[1].trim()) return { status, portal: m[1].trim() };

    // Confirmed real subject (Dutch legacy Wayfarer) -- different wording
    // than the upstream Dutch template ("Besluit over Niantic
    // Wayspot-nominatie voor"), found via a real user inbox.
    m = /Beslissing over je Wayfarer-nominatie,\s*(.+?)\s*$/i.exec(subject);
    if (m && m[1].trim()) return { status, portal: m[1].trim() };

    const collapsed = plaintext.replace(/\s+/g, " ");
    m = /nominate\s+(.+?)\s+on\s+[A-Za-z]+ \d{1,2},? \d{4}/.exec(collapsed);
    if (m) return { status, portal: m[1].trim() };

    const candidates = centeredTextBlocks(doc).filter(
      (d) => d.length > 3 && d.length < 80 && !d.includes("Recon") && !d.includes("Dear")
    );
    return { status, portal: candidates.length ? candidates[0] : null };
  }

  function parseNominationDecided(email, classification) {
    const subject = subjectOf(email);
    const plaintext = plaintextOf(email);
    const doc = htmlDocOf(email);
    const htmlText = (doc && doc.body ? doc.body.textContent : "") || "";
    if (classification.style === Style.INGRESS) return parseOprDecision(subject, plaintext, htmlText);
    return parseNominationDecision(subject, plaintext, doc, htmlText);
  }

  // -------------------------------------------------------------------------
  // Parsing -- Photo submissions (python: parse_photo_portal_name,
  // parse_photo_submission_email, parse_photo_decision)
  // -------------------------------------------------------------------------

  function parsePhotoPortalName(subject) {
    const m = /photo received for (.+?)!?\s*$/i.exec(subject);
    return m ? m[1].trim() : subject.trim();
  }

  function parsePhotoReceived(email) {
    const portalName = parsePhotoPortalName(subjectOf(email));
    return {
      portal: portalName, submission_text: "", supporting_text: "",
      extra_text: [], submission_photo_url: null, supporting_photo_url: null,
    };
  }

  function parsePhotoDecided(email) {
    const subject = subjectOf(email);
    const plaintext = plaintextOf(email);
    const doc = htmlDocOf(email);
    const htmlText = (doc && doc.body ? doc.body.textContent : "") || "";
    const text = (plaintext + " " + htmlText).toLowerCase();
    const status = detectDecisionStatus(text);
    const m = /media submission decided for (.+?)\s*$/i.exec(subject);
    return { status, portal: m ? m[1].trim() : null };
  }

  // -------------------------------------------------------------------------
  // Parsing -- Edit suggestions (python: parse_edit_portal_name_fallback,
  // parse_edit_submission_email, parse_edit_decision)
  // -------------------------------------------------------------------------

  function parseEditPortalNameFallback(subject) {
    const m = /edit suggestion received for (.+?)!?\s*$/i.exec(subject);
    return m ? m[1].trim() : subject.trim();
  }

  function parseEditReceived(email) {
    const subject = subjectOf(email);
    const plaintext = plaintextOf(email);

    const wayspotM = /Wayspot:[ \t]*(.+)/.exec(plaintext);
    const fieldM = /Existing (\w[\w\s]*?):[ \t]*(.*)/.exec(plaintext);
    const suggestedM = /Suggested edit:[ \t]*(.*)/.exec(plaintext);

    const portal = wayspotM ? wayspotM[1].trim() : parseEditPortalNameFallback(subject);
    const editField = fieldM ? toTitleCase(fieldM[1].trim()) : "Unknown";
    const existingValue = fieldM ? fieldM[2].trim() : "";
    const suggestedValue = suggestedM ? suggestedM[1].trim() : "";

    return {
      portal, edit_field: editField,
      submission_text: existingValue ? `Existing ${editField.toLowerCase()}: ${existingValue}` : `(no existing ${editField.toLowerCase()})`,
      supporting_text: `Suggested edit: ${suggestedValue}`,
      suggested_value: suggestedValue,
      extra_text: [], submission_photo_url: null, supporting_photo_url: null,
    };
  }

  // returns {status, editField, dateIso, portalGuess}
  function parseEditDecided(email) {
    const plaintext = plaintextOf(email);
    const doc = htmlDocOf(email);
    const htmlText = (doc && doc.body ? doc.body.textContent : "") || "";
    const text = plaintext + " " + htmlText;
    const lower = text.toLowerCase();

    const status = detectDecisionStatus(lower);

    const m = /Wayspot (\w[\w\s]*?) suggestion for (.+?) on ([A-Za-z]+ \d{1,2},? \d{4})/.exec(text);
    if (!m) return { status, editField: null, dateIso: null, portalGuess: null };

    const editField = toTitleCase(m[1].trim());
    const portalGuess = m[2].trim();
    const dateIso = parseEmailDate(m[3].replace(",", ""));

    return { status, editField, dateIso, portalGuess };
  }

  // -------------------------------------------------------------------------
  // Parsing -- Appeals (python: parse_appeal_received, parse_appeal_decision,
  // dates_approximately_match)
  // -------------------------------------------------------------------------

  // classification.type is NOMINATION_APPEAL_RECEIVED or EDIT_APPEAL_RECEIVED,
  // but the actual target (Nomination vs Photo vs Edit) can only be told
  // apart by the body wording -- same as the Python version.
  function parseAppealReceived(email, classification) {
    const subject = subjectOf(email);
    const plaintext = plaintextOf(email);
    const doc = htmlDocOf(email);

    const mNom = /for your nomination:\s*(.+?),\s*originally submitted on ([A-Za-z]+ \d{1,2},? \d{4})/.exec(plaintext);
    const mPhoto = /for your (?:Wayspot )?[Pp]hoto(?: submission)?:\s*(.+?),\s*originally submitted on ([A-Za-z]+ \d{1,2},? \d{4})/.exec(plaintext);
    const mEdit = /for your Wayspot edit,\s*originally submitted on ([A-Za-z]+ \d{1,2},? \d{4})/.exec(plaintext);

    let targetType, portal, origDateRaw;
    let editField = null, submissionPhotoUrl = null, supportingPhotoUrl = null;

    if (mNom) {
      targetType = "Nomination"; portal = mNom[1].trim(); origDateRaw = mNom[2];
    } else if (mPhoto) {
      targetType = "Photo"; portal = mPhoto[1].trim(); origDateRaw = mPhoto[2];
    } else if (mEdit) {
      targetType = "Edit"; origDateRaw = mEdit[1];
      const wayspotM = /Wayspot:[ \t]*(.+)/.exec(plaintext);
      portal = wayspotM ? wayspotM[1].trim() : parseEditPortalNameFallback(subject);
    } else {
      targetType = "Unknown";
      // Confirmed real subject (Dutch legacy Wayfarer) -- the body-text
      // patterns above are English-only, so a Dutch appeal-received email
      // would otherwise fall through to the English edit-fallback regex,
      // which also won't match, leaving the whole subject as the "portal
      // name". Catch it here instead, before that fallback.
      const dutchM = /bezwaar ontvangen voor (.+?)!?\s*$/i.exec(subject);
      portal = dutchM ? dutchM[1].trim() : parseEditPortalNameFallback(subject);
      origDateRaw = null;
    }

    const originalSubmittedDate = origDateRaw ? parseEmailDate(origDateRaw.replace(",", "")) : null;

    let submissionText = "", supportingText = "";
    if (targetType === "Edit") {
      const fieldM = /Existing (\w[\w\s]*?):[ \t]*(.*)/.exec(plaintext);
      const suggestedM = /Suggested edit:[ \t]*(.*)/.exec(plaintext);
      editField = fieldM ? toTitleCase(fieldM[1].trim()) : "Unknown";
      const existingValue = fieldM ? fieldM[2].trim() : "";
      const suggestedValue = suggestedM ? suggestedM[1].trim() : "";
      submissionText = existingValue ? `Existing ${editField.toLowerCase()}: ${existingValue}` : `(no existing ${editField.toLowerCase()})`;
      supportingText = `Suggested edit: ${suggestedValue}`;
    } else {
      submissionPhotoUrl = photoUrl(doc, "Submission Photo");
      supportingPhotoUrl = photoUrl(doc, "Supporting Photo");
      const textBlocks = centeredTextBlocks(doc);
      const idx = textBlocks.indexOf(portal);
      if (idx >= 0) {
        const cleaned = [];
        for (const t of textBlocks.slice(idx + 1)) {
          if (t.startsWith("Your appeal will be reviewed") || t.includes("Recon Criteria")) break;
          cleaned.push(t);
        }
        if (cleaned.length > 0) submissionText = cleaned[0];
        if (cleaned.length > 1) supportingText = cleaned[1];
      }
    }

    return {
      target_type: targetType, portal, original_submitted_date: originalSubmittedDate,
      edit_field: editField, submission_text: submissionText, supporting_text: supportingText,
      submission_photo_url: submissionPhotoUrl, supporting_photo_url: supportingPhotoUrl,
    };
  }

  // *** BEST-EFFORT / UNCONFIRMED -- see note on the decided-appeal template. ***
  function parseAppealDecided(email) {
    const subject = subjectOf(email);
    const plaintext = plaintextOf(email);
    const doc = htmlDocOf(email);
    const htmlText = (doc && doc.body ? doc.body.textContent : "") || "";
    const text = plaintext + " " + htmlText;
    const lower = text.toLowerCase();

    const status = detectDecisionStatus(lower);

    // Confirmed real subject (Dutch legacy Wayfarer) -- unlike the
    // English best-effort template, the portal name is right there in the
    // subject line, so use it directly instead of guessing from HTML.
    const dutchM = /bezwaar voor (.+?)\s*$/i.exec(subject);
    if (dutchM && dutchM[1].trim()) {
      return { status, portalGuess: dutchM[1].trim() };
    }

    const candidates = centeredTextBlocks(doc).filter(
      (d) => d.length > 3 && d.length < 80 && !d.includes("Recon") && !d.includes("Dear") && !d.toLowerCase().includes("appeal")
    );
    return { status, portalGuess: candidates.length ? candidates[0] : null };
  }

  function datesApproximatelyMatch(dateA, dateB, toleranceDays = 1) {
    if (!dateA || !dateB) return false;
    if (dateA === dateB) return true;
    const d1 = new Date(dateA + "T00:00:00Z");
    const d2 = new Date(dateB + "T00:00:00Z");
    if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return false;
    return Math.abs(d1.getTime() - d2.getTime()) <= toleranceDays * 86400000;
  }

  // -------------------------------------------------------------------------
  // Collection / matching (python: seed_entries, collect_nominations,
  // collect_edits, collect (generic, used for Photo), apply_appeals,
  // build_title_alias_map, resolve_via_title_aliases,
  // resolve_unmatched_nomination_decisions)
  //
  // classifiedEmails: array of { email: OPREmail.Email, classification, dateIso }
  // -------------------------------------------------------------------------

  const STYLE_TO_SOURCE = {
    RECON: "Spatial", WAYFARER: "Wayfarer", INGRESS: "OPR",
    POKEMON_GO: "Pokemon GO", REDACTED: "Unknown", LIGHTSHIP: "Unknown", UNKNOWN: "Unknown",
  };
  function sourceForStyle(style) { return STYLE_TO_SOURCE[style] || style; }

  function collectNominations(classifiedEmails) {
    const entries = new Map(); // key: portal.toLowerCase()+"|"+date
    const unmatchedDecisions = [];

    const received = classifiedEmails.filter((c) => c.classification.type === Type.NOMINATION_RECEIVED);
    // Spatial (RECON) first, so a legacy Wayfarer/OPR dupe of the same
    // portal+date is skipped in favor of the newer-era data -- same
    // precedence the Python script used.
    const bySource = { RECON: [], WAYFARER: [], INGRESS: [] };
    for (const c of received) {
      const bucket = bySource[c.classification.style] || bySource.WAYFARER;
      bucket.push(c);
    }

    for (const c of bySource.RECON) {
      const parsed = parseNominationReceived(c.email, c.classification);
      const key = `${parsed.portal.toLowerCase()}|${c.dateIso}`;
      entries.set(key, {
        ...parsed, submitted_date: c.dateIso, status: "Pending",
        submission_type: "Nomination", source: "Spatial", _lastDecisionDate: null,
      });
    }
    for (const c of bySource.WAYFARER) {
      const parsed = parseNominationReceived(c.email, c.classification);
      const key = `${parsed.portal.toLowerCase()}|${c.dateIso}`;
      const existing = entries.get(key);
      if (existing && existing.source === "Spatial") continue;
      entries.set(key, {
        ...parsed, submitted_date: c.dateIso, status: "Pending",
        submission_type: "Nomination", source: "Wayfarer", _lastDecisionDate: null,
      });
    }
    for (const c of bySource.INGRESS) {
      const parsed = parseNominationReceived(c.email, c.classification);
      const key = `${parsed.portal.toLowerCase()}|${c.dateIso}`;
      const existing = entries.get(key);
      if (existing && (existing.source === "Spatial" || existing.source === "Wayfarer")) continue;
      entries.set(key, {
        ...parsed, submitted_date: c.dateIso, status: "Pending",
        submission_type: "Nomination", source: "OPR", _lastDecisionDate: null,
      });
    }

    const decided = classifiedEmails.filter((c) => c.classification.type === Type.NOMINATION_DECIDED);
    for (const c of decided) {
      const { status, portal } = parseNominationDecided(c.email, c.classification);
      if (!portal) continue;
      const decisionSource = sourceForStyle(c.classification.style);
      let match = null;
      for (const e of entries.values()) {
        if (e.portal.toLowerCase() === portal.toLowerCase() && e.source === decisionSource) { match = e; break; }
      }
      if (!match) {
        unmatchedDecisions.push({ status, portalGuess: portal, decisionDate: c.dateIso, source: decisionSource });
        continue;
      }
      const prevDate = match._lastDecisionDate;
      if (prevDate === null || (c.dateIso && c.dateIso >= prevDate)) {
        if (status) {
          match.status = status;
        } else if (!match.notes) {
          match.notes = "A decision arrived for this portal, but the outcome couldn't be determined automatically -- check the original email.";
        }
        match._lastDecisionDate = c.dateIso;
      }
    }

    for (const e of entries.values()) delete e._lastDecisionDate;
    return { nominations: Array.from(entries.values()), unmatchedDecisions };
  }

  function collectPhotos(classifiedEmails) {
    const entries = new Map();
    for (const c of classifiedEmails.filter((c) => c.classification.type === Type.PHOTO_RECEIVED)) {
      const parsed = parsePhotoReceived(c.email);
      const source = sourceForStyle(c.classification.style);
      const key = `${parsed.portal.toLowerCase()}|${c.dateIso}|${source}`;
      entries.set(key, {
        ...parsed, submitted_date: c.dateIso, status: "Pending",
        submission_type: "Photo", source,
      });
    }
    for (const c of classifiedEmails.filter((c) => c.classification.type === Type.PHOTO_DECIDED)) {
      const { status, portal } = parsePhotoDecided(c.email);
      if (!status || !portal) continue;
      const source = sourceForStyle(c.classification.style);
      for (const e of entries.values()) {
        if (e.portal.toLowerCase() === portal.toLowerCase() && e.source === source) { e.status = status; break; }
      }
    }
    return Array.from(entries.values());
  }

  function collectEdits(classifiedEmails) {
    const entries = new Map(); // key: field|date|portal|source

    for (const c of classifiedEmails.filter((c) => c.classification.type === Type.EDIT_RECEIVED)) {
      const parsed = parseEditReceived(c.email);
      const source = sourceForStyle(c.classification.style);
      const key = `${parsed.edit_field}|${c.dateIso}|${parsed.portal}|${source}`;
      entries.set(key, {
        ...parsed, submitted_date: c.dateIso, status: "Pending",
        submission_type: "Edit", source,
      });
    }

    for (const c of classifiedEmails.filter((c) => c.classification.type === Type.EDIT_DECIDED)) {
      const { status, editField, dateIso } = parseEditDecided(c.email);
      if (!status || !editField || !dateIso) continue;
      const source = sourceForStyle(c.classification.style);
      for (const entry of entries.values()) {
        if (entry.edit_field === editField && entry.submitted_date === dateIso && entry.source === source) {
          entry.status = status;
          break;
        }
      }
    }

    return Array.from(entries.values());
  }

  // python: apply_appeals -- mutates `entries` in place (array of submission
  // records) based on NOMINATION_APPEAL_RECEIVED/EDIT_APPEAL_RECEIVED and the
  // best-effort *_APPEAL_DECIDED emails.
  function applyAppeals(entries, classifiedEmails) {
    const received = classifiedEmails.filter(
      (c) => c.classification.type === Type.NOMINATION_APPEAL_RECEIVED || c.classification.type === Type.EDIT_APPEAL_RECEIVED
    );

    for (const c of received) {
      const parsed = parseAppealReceived(c.email, c.classification);
      const appealSource = sourceForStyle(c.classification.style);
      let match = null;
      for (const e of entries) {
        if (
          e.portal.toLowerCase() === parsed.portal.toLowerCase() &&
          e.source === appealSource &&
          datesApproximatelyMatch(e.submitted_date, parsed.original_submitted_date) &&
          (parsed.target_type === "Unknown" || e.submission_type === parsed.target_type)
        ) {
          match = e; break;
        }
      }
      if (match) {
        match.status = "Appeal";
      } else {
        const fallbackType = parsed.target_type !== "Unknown" ? parsed.target_type : "Nomination";
        entries.push({
          portal: parsed.portal, submitted_date: parsed.original_submitted_date || "",
          status: "Appeal", submission_type: fallbackType, source: sourceForStyle(c.classification.style),
          edit_field: parsed.edit_field, submission_text: parsed.submission_text,
          supporting_text: parsed.supporting_text, extra_text: [],
          submission_photo_url: parsed.submission_photo_url, supporting_photo_url: parsed.supporting_photo_url,
          latitude: null, longitude: null,
          notes: "Could not automatically match this appeal to an original submission -- added as a new entry for review.",
        });
      }
    }

    const decided = classifiedEmails.filter(
      (c) => c.classification.type === Type.NOMINATION_APPEAL_DECIDED || c.classification.type === Type.EDIT_APPEAL_DECIDED
    );
    for (const c of decided) {
      const { status, portalGuess } = parseAppealDecided(c.email);
      if (!portalGuess) continue;
      const decisionSource = sourceForStyle(c.classification.style);
      for (const e of entries) {
        if (e.portal.toLowerCase() === portalGuess.toLowerCase() && e.status === "Appeal" && e.source === decisionSource) {
          if (status) e.status = status;
          else if (!e.notes) e.notes = "A decision arrived for this appeal, but the outcome couldn't be determined automatically -- check the original email.";
          break;
        }
      }
    }
  }

  // python: build_title_alias_map / resolve_via_title_aliases /
  // resolve_unmatched_nomination_decisions
  function buildTitleAliasMap(edits) {
    const aliases = {};
    for (const e of edits) {
      if (e.edit_field === "Title" && e.status === "Accepted" && e.suggested_value) {
        const newName = e.suggested_value.trim().toLowerCase();
        const originalName = e.portal.trim().toLowerCase();
        if (newName && newName !== originalName) aliases[newName] = originalName;
      }
    }
    return aliases;
  }

  function resolveViaTitleAliases(name, titleAliases) {
    const seen = new Set();
    let current = name.trim().toLowerCase();
    while (current in titleAliases && !seen.has(current)) {
      seen.add(current);
      current = titleAliases[current];
    }
    return current;
  }

  function resolveUnmatchedNominationDecisions(nominations, unmatchedDecisions, titleAliases) {
    const stillUnmatched = [];
    for (const dec of unmatchedDecisions) {
      const resolvedName = resolveViaTitleAliases(dec.portalGuess, titleAliases);
      const match = nominations.find((e) => e.portal.trim().toLowerCase() === resolvedName);
      if (match) {
        if (dec.status) match.status = dec.status;
        else if (!match.notes) match.notes = "A decision arrived for this portal, but the outcome couldn't be determined automatically -- check the original email.";
      } else {
        stillUnmatched.push(dec);
      }
    }
    for (const dec of stillUnmatched) {
      nominations.push({
        portal: dec.portalGuess, submitted_date: dec.decisionDate || "", status: dec.status || "Pending",
        submission_type: "Nomination", source: dec.source, submission_text: "", supporting_text: "",
        extra_text: [], submission_photo_url: null, supporting_photo_url: null, latitude: null, longitude: null,
        notes: dec.status
          ? "Could not automatically match this decision to a submitted nomination (possibly renamed) -- added for manual review."
          : "Could not automatically match this decision to a submitted nomination, and its outcome couldn't be determined either -- added for manual review, check the original email for the actual status.",
      });
    }
    return nominations;
  }

  // -------------------------------------------------------------------------
  // Top-level entry point (python: main(), minus the Gmail-fetching parts)
  // -------------------------------------------------------------------------

  // classifiedEmails: array of { email, classification, dateIso }
  // Returns the same "submissions" array shape the panel/importer already
  // understand: { portal, submitted_date, status, submission_type, source,
  // submission_text, supporting_text, extra_text, submission_photo_url,
  // supporting_photo_url, latitude, longitude, edit_field?, suggested_value?, notes? }
  function search(classifiedEmails) {
    const { nominations, unmatchedDecisions } = collectNominations(classifiedEmails);
    const photos = collectPhotos(classifiedEmails);
    const edits = collectEdits(classifiedEmails);

    let resolvedNominations = nominations;
    if (unmatchedDecisions.length) {
      const titleAliases = buildTitleAliasMap(edits);
      resolvedNominations = resolveUnmatchedNominationDecisions(nominations, unmatchedDecisions, titleAliases);
    }

    const results = [...resolvedNominations, ...photos, ...edits];
    applyAppeals(results, classifiedEmails);

    results.sort((a, b) => (b.submitted_date || "").localeCompare(a.submitted_date || ""));
    return results;
  }

  global.WST = {
    search,
    // exported individually too, in case the panel UI wants to show
    // per-email classification/debug info
    parseNominationReceived, parseNominationDecided, parsePhotoReceived, parsePhotoDecided,
    parseEditReceived, parseEditDecided, parseAppealReceived, parseAppealDecided,
    parseEmailDate, centeredTextBlocks, parseCoordinates,
  };
})(window);
