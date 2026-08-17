const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { makeEmail, loadLibs } = require("./helpers");

// These exact subject lines came from a real user's "didn't match a known
// template" list. Upstream OPR-Tools has no Dutch appeal templates at all,
// and its one Dutch NOMINATION_DECIDED template uses different wording than
// these -- see the comments in opr-email-lib.js's SUPPLEMENTAL_TEMPLATES.
describe("Dutch legacy Wayfarer templates (regression)", () => {
  const cases = [
    ["Niantic heeft een besluit genomen over je bezwaar voor Hulst", "NOMINATION_APPEAL_DECIDED", "Hulst"],
    ["Beslissing over je Wayfarer-nominatie, Wereldtijdpad #348 - Trompetfibulae", "NOMINATION_DECIDED", "Wereldtijdpad #348 - Trompetfibulae"],
    ["Beslissing over je Wayfarer-nominatie, Wereldtijdpad #810", "NOMINATION_DECIDED", "Wereldtijdpad #810"],
    ["Bedankt! Niantic Wayspot-bezwaar ontvangen voor Wandelknooppunt G25!", "NOMINATION_APPEAL_RECEIVED", "Wandelknooppunt G25"],
    ["Bedankt! Niantic Wayspot-bezwaar ontvangen voor Reggedalroute!", "NOMINATION_APPEAL_RECEIVED", "Reggedalroute"],
    ["Beslissing over je Wayfarer-nominatie, Wandelkeuzepunt G76", "NOMINATION_DECIDED", "Wandelkeuzepunt G76"],
  ];

  for (const [subject, expectedType, expectedPortal] of cases) {
    test(`classifies and extracts portal name from "${subject}"`, () => {
      const { OPREmail, WST } = loadLibs();
      const raw = makeEmail({
        subject, date: "Mon, 10 Aug 2026 12:00:00 +0000", plaintext: "body",
        from: "notices@wayfarer.nianticlabs.com",
      });
      const email = OPREmail.parseMIME(raw);
      const cls = email.classify();
      assert.equal(cls.type, expectedType);
      assert.equal(cls.style, "WAYFARER");
      assert.equal(cls.language, "nl");

      let extracted;
      if (cls.type === "NOMINATION_DECIDED") extracted = WST.parseNominationDecided(email, cls);
      else if (cls.type === "NOMINATION_APPEAL_RECEIVED") extracted = WST.parseAppealReceived(email, cls);
      else if (cls.type === "NOMINATION_APPEAL_DECIDED") extracted = WST.parseAppealDecided(email);

      assert.equal(extracted.portal || extracted.portalGuess, expectedPortal);
    });
  }

  test("a decision with an undetermined status is flagged for review instead of silently dropped", () => {
    const { OPREmail, WST } = loadLibs();
    // Received (English/Wayfarer) then a Dutch decision whose outcome our
    // best-effort keywords can't determine (no "gefeliciteerd"/"helaas"
    // present in the body).
    const received = (() => {
      const email = OPREmail.parseMIME(makeEmail({
        subject: "Thanks! Niantic Wayspot nomination received for Hulst!",
        date: "Mon, 03 Jan 2022 12:00:00 +0000",
        plaintext: "What you submitted:\nHulst\nA tree.\nNice tree.",
        from: "notices@wayfarer.nianticlabs.com",
      }));
      return { email, classification: email.classify(), dateIso: WST.parseEmailDate(email.getFirstHeaderValue("Date")) };
    })();
    const decided = (() => {
      const email = OPREmail.parseMIME(makeEmail({
        subject: "Beslissing over je Wayfarer-nominatie, Hulst",
        date: "Fri, 25 Mar 2022 09:36:39 +0000",
        plaintext: "Ambiguous body text with no recognized status keywords.",
        from: "notices@wayfarer.nianticlabs.com",
      }));
      return { email, classification: email.classify(), dateIso: WST.parseEmailDate(email.getFirstHeaderValue("Date")) };
    })();

    const results = WST.search([received, decided]);
    const entry = results.find((r) => r.portal === "Hulst");
    assert.ok(entry, "the entry must still exist, not be silently dropped");
    assert.equal(entry.status, "Pending", "status should be left alone when the decision's outcome is undetermined");
    assert.match(entry.notes, /outcome couldn't be determined/);
  });
});
