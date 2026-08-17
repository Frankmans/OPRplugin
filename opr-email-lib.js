// ===========================================================================
// opr-email-lib.js
//
// A vanilla-JS port of bilde2910/OPR-Tools' src/email module
// (https://github.com/bilde2910/OPR-Tools/tree/main/src/email), for use in
// standalone Tampermonkey userscripts that have no build step / bundler.
//
// Ported pieces, each mirroring the upstream file of the same purpose:
//   - errors.ts    -> error classes
//   - types.ts     -> EmailType / EmailStyle enums, Header/StoredEmail shape
//   - parsing.ts   -> parseMIME, extractEmail, decodeBodyUsingCTE (RFC 2047,
//                      quoted-printable, base64)
//   - templates.ts -> the full subject-line classification template table,
//                      byte-for-byte (only TypeScript type annotations were
//                      stripped -- every regex and disambiguate() function
//                      body is unmodified)
//   - index.ts     -> the Email class (headers/body access, multipart
//                      alternative extraction, classify()) and
//                      EmailAPI.stripDiacritics()
//
// Deliberately NOT ported: EmailAPI's IndexedDB storage/import-listener
// machinery (index.ts's EmailAPI class) -- that's specific to the full
// OPR-Tools web app's DB layer. The importer userscript in this repo has
// its own lightweight IndexedDB store instead, using the same StoredEmail
// shape so the two are still compatible.
//
// Exposed as a single global: window.OPREmail
// ===========================================================================
(function (global) {
  "use strict";

  // -------------------------------------------------------------------------
  // errors.ts
  // -------------------------------------------------------------------------
  class InvalidEmailFormatError extends Error {}
  class NotImplementedError extends Error {}
  class InvalidContentTypeError extends Error {}
  class HeaderNotFoundError extends Error {}
  class NoMatchingTemplateError extends Error {}
  class DisambiguationFailedError extends Error {}

  // -------------------------------------------------------------------------
  // types.ts
  // -------------------------------------------------------------------------
  const Type = {
    CHALLENGE_REWARD: "CHALLENGE_REWARD",
    EDIT_APPEAL_DECIDED: "EDIT_APPEAL_DECIDED",
    EDIT_APPEAL_RECEIVED: "EDIT_APPEAL_RECEIVED",
    EDIT_DECIDED: "EDIT_DECIDED",
    EDIT_RECEIVED: "EDIT_RECEIVED",
    MISCELLANEOUS: "MISCELLANEOUS",
    NOMINATION_APPEAL_DECIDED: "NOMINATION_APPEAL_DECIDED",
    NOMINATION_APPEAL_RECEIVED: "NOMINATION_APPEAL_RECEIVED",
    NOMINATION_DECIDED: "NOMINATION_DECIDED",
    NOMINATION_RECEIVED: "NOMINATION_RECEIVED",
    PHOTO_DECIDED: "PHOTO_DECIDED",
    PHOTO_RECEIVED: "PHOTO_RECEIVED",
    REPORT_DECIDED: "REPORT_DECIDED",
    REPORT_RECEIVED: "REPORT_RECEIVED",
    SURVEY: "SURVEY",
  };

  const Style = {
    INGRESS: "INGRESS",
    LIGHTSHIP: "LIGHTSHIP",
    POKEMON_GO: "POKEMON_GO",
    REDACTED: "REDACTED",
    WAYFARER: "WAYFARER",
    RECON: "RECON",
    UNKNOWN: "UNKNOWN",
  };

  // -------------------------------------------------------------------------
  // diacritics.json
  // -------------------------------------------------------------------------
  const DIACRITICS = {"A":"ÀÁÂÃÅÄĀĂĄǍǞǠǺȀȂȦ","C":"ÇĆĈĊČ","D":"Ď","E":"ÈÊËÉĒĔĖĘĚȄȆȨ","G":"ĜĞĠĢǦǴ","H":"ĤȞ","I":"ÌÍÎÏĨĪĬĮİǏȈȊ","J":"Ĵ","K":"ĶǨ","L":"ĹĻĽ","N":"ÑŃŅŇǸ","O":"ÒÔÕÓÖŌŎŐƠǑǪǬȌȎȪȬȮȰ","R":"ŔŖŘȐȒ","S":"ŚŜŞŠȘ","T":"ŢŤȚ","U":"ÙÚÛÜŨŪŬŮŰŲƯǓǕǗǙǛȔȖ","W":"Ŵ","Y":"ÝŶŸȲ","Z":"ŹŻŽ","a":"àáâãåäāăąǎǟǡǻȁȃȧ","c":"çćĉċč","d":"ď","e":"èêëéēĕėęěȅȇȩ","g":"ĝğġģǧǵ","h":"ĥȟ","i":"ìíîïĩīĭįǐȉȋ","j":"ĵǰ","k":"ķǩ","l":"ĺļľ","n":"ñńņňǹ","o":"òôõóöōŏőơǒǫǭȍȏȫȭȯȱ","r":"ŕŗřȑȓ","s":"śŝşšș","t":"ţťț","u":"ùúûüũūŭůűųưǔǖǘǚǜȕȗ","w":"ŵ","y":"ýÿŷȳ","z":"źżž","Æ":"ǢǼ","Ø":"Ǿ","æ":"ǣǽ","ø":"ǿ","Ʒ":"Ǯ","ʒ":"ǯ","'":"\""};

  function stripDiacritics(text) {
    for (const [k, v] of Object.entries(DIACRITICS)) {
      text = text.replace(new RegExp(`[${v}]`, "g"), k);
    }
    return text.normalize("NFD");
  }

  // -------------------------------------------------------------------------
  // parsing.ts
  // -------------------------------------------------------------------------
  const ENCODED_WORD_REGEX = /=\?([A-Za-z0-9-]+)\?([QqBb])\?([^?]+)\?=(?:\s+(?==\?[A-Za-z0-9-]+\?[QqBb]\?[^?]+\?=))?/g;

  const extractEmail = (headerValue) => {
    // Technically not spec-compliant
    const sb = headerValue.lastIndexOf("<");
    const eb = headerValue.lastIndexOf(">");
    if (sb < 0 && eb < 0) return headerValue;
    return headerValue.substring(sb + 1, eb);
  };

  const parseMIME = (data) => {
    const bound = data.indexOf("\r\n\r\n");
    if (bound < 0) throw new InvalidEmailFormatError("Cannot find boundary between headers and body");
    const headers = data.substring(0, bound).replace(/\r\n\s/g, " ").split(/\r\n/).map((h) => parseHeader(h));
    const body = data.substring(bound + 4);
    return new Email(headers, body);
  };

  const parseHeader = (headerLine) => {
    const b = headerLine.indexOf(":");
    const token = headerLine.substring(0, b);
    // Decode RFC 2047 atoms
    const field = headerLine
      .substring(b + 1)
      .trim()
      .replace(ENCODED_WORD_REGEX, (_, c, e, t) => parseEncodedWord(c, e, t));
    return {
      name: token,
      value: field.trim(),
    };
  };

  const parseEncodedWord = (charset, encoding, text) => {
    switch (encoding) {
      case "Q":
      case "q":
        return new TextDecoder(charset).decode(qpStringToU8A(text.split("_").join(" ")));
      case "B":
      case "b":
        return charset.toLowerCase() == "utf-8" ? atobUTF8(text) : atob(text);
      default:
        throw new InvalidEmailFormatError(`Invalid RFC 2047 encoding format: ${encoding}`);
    }
  };

  const qpStringToU8A = (str) => {
    const u8a = new Uint8Array(str.length - (2 * (str.split("=").length - 1)));
    for (let i = 0, j = 0; i < str.length; i++, j++) {
      if (str[i] !== "=") {
        u8a[j] = str.codePointAt(i);
      } else {
        u8a[j] = parseInt(str.substring(i + 1, i + 3), 16);
        i += 2;
      }
    }
    return u8a;
  };

  // https://stackoverflow.com/a/30106551/1955334
  const atobUTF8 = (text) => decodeURIComponent(atob(text)
    .split("")
    .map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
    .join(""));

  const decodeBodyUsingCTE = (body, cte, charset) => {
    switch (cte) {
      case null:
        return body;
      case "quoted-printable":
        return unfoldQuotedPrintable(body, charset);
      case "base64":
        return charset.toLowerCase() === "utf-8" ? atobUTF8(body) : atob(body);
      default:
        throw new NotImplementedError(`Unknown Content-Transfer-Encoding ${cte}`);
    }
  };

  const unfoldQuotedPrintable = (body, charset) => {
    // Unfold QP CTE
    const td = new TextDecoder(charset);
    return body
      .split(/=\r?\n/).join("")
      .split(/\r?\n/).map((line) => td.decode(qpStringToU8A(line)))
      .join("\n");
  };

  // -------------------------------------------------------------------------
  // index.ts -- Email class
  // -------------------------------------------------------------------------
  class Email {
    constructor(headers, body) {
      this.headers = headers;
      this.body = body;
      this._cache = {};
    }

    getHeaderValues(name) {
      return this.headers
        .filter((h) => h.name.toLowerCase() === name.toLowerCase())
        .map((h) => h.value);
    }

    getFirstHeaderValue(name, defaultValue) {
      const hvs = this.getHeaderValues(name);
      if (hvs.length) return hvs[0];
      if (typeof defaultValue !== "undefined") return defaultValue;
      throw new HeaderNotFoundError(`Could not find any headers with name ${name}`);
    }

    getBody(contentType) {
      const alts = this.getMultipartAlternatives();
      return alts[contentType.toLowerCase()] ?? null;
    }

    getMultipartAlternatives() {
      const alts = {};
      const ct = this._parseContentType(this.getFirstHeaderValue("Content-Type"));
      if (ct.type === "multipart/alternative") {
        const parts = this.body.split(`--${ct.params.boundary}`).filter(part => part !== "");
        for (const part of parts) {
          if (!part.startsWith("\r\n") || !part.endsWith("\r\n")) continue;
          const partMime = parseMIME(part.substring(2, part.length - 2));
          if (partMime.body.trim().length === 0) continue;
          const partCTHdr = partMime.getFirstHeaderValue("Content-Type", null);
          if (partCTHdr === null) continue;
          const partCT = this._parseContentType(partCTHdr);
          const partCTE = partMime.getFirstHeaderValue("Content-Transfer-Encoding", null);
          const partCharset = (partCT.params.charset ?? "utf-8").toLowerCase();
          alts[partCT.type] = decodeBodyUsingCTE(partMime.body, partCTE, partCharset);
        }
      } else {
        const cte = this.getFirstHeaderValue("Content-Transfer-Encoding", null);
        const charset = (ct.params.charset ?? "utf-8").toLowerCase();
        alts[ct.type] = decodeBodyUsingCTE(this.body, cte, charset);
      }
      return alts;
    }

    getDocument() {
      if (typeof this._cache.document !== "undefined") {
        return this._cache.document;
      } else {
        const html = this.getBody("text/html");
        if (!html) return null;
        const dp = new DOMParser();
        this._cache.document = dp.parseFromString(html, "text/html");
        return this._cache.document;
      }
    }

    classify() {
      if (typeof this._cache.classification !== "undefined") {
        if (this._cache.classification === null) {
          throw new DisambiguationFailedError("Disambiguation of ambiguous email template failed");
        }
        return this._cache.classification;
      } else {
        const subject = this.getFirstHeaderValue("Subject");
        for (const template of TEMPLATES) {
          if (subject.match(template.subject)) {
            if ("disambiguate" in template && typeof template.disambiguate !== "undefined") {
              this._cache.classification = template.disambiguate(this);
            } else if ("type" in template) {
              this._cache.classification = {
                type: template.type,
                style: template.style,
                language: template.language,
              };
            } else {
              this._cache.classification = null;
            }
            return this.classify();
          }
        }
      }
      throw new NoMatchingTemplateError("This email does not appear to match any styles of Niantic emails currently known to Email API.");
    }

    _parseContentType(ctHeader) {
      const m = ctHeader.match(/^([^/]+\/[^/;\s]+)(?=($|((?:;[^;]*)*)))/);
      if (m === null) throw new InvalidContentTypeError(`Unrecognized Content-Type ${ctHeader}`);
      const type = m[1];
      const params = m[2];
      const paramMap = {};
      if (params) {
        const paramList = params.substring(1).split(";");
        for (const param of paramList) {
          const [attr, value] = param.trim().split("=");
          if (!attr || typeof value === "undefined") continue;
          paramMap[attr.toLowerCase()] = (
            value.startsWith("\"") && value.endsWith("\"")
              ? value.substring(1, value.length - 1)
              : value
          );
        }
      }
      return {
        type: type.toLowerCase(),
        params: paramMap,
      };
    }
  }

const TEMPLATES = [
//  ---------------------------------------- MISCELLANEOUS ----------------------------------------
  {
    subject: /^Ingress Mission/,
    type: Type.MISCELLANEOUS,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Ingress Damage Report:/,
    type: Type.MISCELLANEOUS,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Help us improve Wayfarer$/,
    type: Type.SURVEY,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Help us tackle Wayfarer Abuse$/,
    type: Type.SURVEY,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Global Challenge Rewards$/,
    type: Type.CHALLENGE_REWARD,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Your Wayspot submission for/,
    type: Type.NOMINATION_DECIDED,
    style: Style.LIGHTSHIP,
    language: "en",
  },
  {
    subject: /Activated on VPS$/,
    type: Type.MISCELLANEOUS,
    style: Style.LIGHTSHIP,
    language: "en",
  },
  {
    subject: /^Re: \[\d+\] /,
    type: Type.MISCELLANEOUS,
    style: Style.UNKNOWN,
    language: "en",
  },
  //  ---------------------------------------- ENGLISH [en] ----------------------------------------
  {
    subject: /^Thanks! Niantic Spatial Wayspot nomination received for/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Spatial Wayspot edit suggestion received for/,
    type: Type.EDIT_RECEIVED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Niantic Spatial Wayspot edit suggestion decided for/,
    type: Type.EDIT_DECIDED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Spatial Wayspot Photo received for/,
    type: Type.PHOTO_RECEIVED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Spatial Wayspot location edit appeal received for/,
    type: Type.EDIT_APPEAL_RECEIVED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Spatial location report received for/,
    type: Type.REPORT_RECEIVED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Niantic Spatial location report decided for/,
    type: Type.REPORT_DECIDED,
    style: Style.RECON,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Wayspot nomination received for/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Niantic Wayspot nomination decided for/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Decision on your? Wayfarer Nomination,/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Wayspot appeal received for/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Your Niantic Wayspot appeal has been decided for/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Wayspot (location|title|description) edit {2}appeal received for/,
    type: Type.EDIT_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Your Niantic Wayspot (location|title|description) edit appeal has been decided for/,
    type: Type.EDIT_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Portal submission confirmation:/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Portal review complete:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Ingress Portal Submitted:/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.REDACTED,
    language: "en",
  },
  {
    subject: /^Ingress Portal Duplicate:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.REDACTED,
    language: "en",
  },
  {
    subject: /^Ingress Portal Live:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.REDACTED,
    language: "en",
  },
  {
    subject: /^Ingress Portal Rejected:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.REDACTED,
    language: "en",
  },
  {
    subject: /^Trainer [^:]+: Thank You for Nominating a PokéStop for Review.$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Trainer [^:]+: Your PokéStop Nomination Is Eligible!$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Trainer [^:]+: Your PokéStop Nomination Is Ineligible$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Trainer [^:]+: Your PokéStop Nomination Review Is Complete:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Photo Submission Received$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Photo Submission (Accepted|Rejected)$/,
    type: Type.PHOTO_DECIDED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Edit Suggestion Received$/,
    type: Type.EDIT_RECEIVED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Edit Suggestion (Accepted|Rejected)$/,
    type: Type.EDIT_DECIDED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Invalid Pokéstop\/Gym Report Received$/,
    type: Type.REPORT_RECEIVED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Invalid Pokéstop\/Gym Report (Accepted|Rejected)$/,
    type: Type.REPORT_DECIDED,
    style: Style.POKEMON_GO,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Wayspot Photo received for/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Niantic Wayspot media submission decided for/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic Wayspot edit suggestion received for/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Niantic Wayspot edit suggestion decided for/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Thanks! Niantic (Wayspot|location) report received for/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Niantic (Wayspot|location) report decided for/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "en",
  },
  {
    subject: /^Portal photo submission confirmation/,
    type: Type.PHOTO_RECEIVED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Portal photo review complete/,
    type: Type.PHOTO_DECIDED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Portal Edit Suggestion Received$/,
    type: Type.EDIT_RECEIVED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Portal edit submission confirmation/,
    type: Type.EDIT_RECEIVED,
    style: Style.REDACTED,
    language: "en",
  },
  {
    subject: /^Portal edit review complete/,
    type: Type.EDIT_DECIDED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Invalid Ingress Portal report received$/,
    type: Type.REPORT_RECEIVED,
    style: Style.INGRESS,
    language: "en",
  },
  {
    subject: /^Invalid Ingress Portal report reviewed$/,
    type: Type.REPORT_DECIDED,
    style: Style.INGRESS,
    language: "en",
  },
  //  ---------------------------------------- BENGALI [bn] ----------------------------------------
  {
    subject: /^ধন্যবাদ! .*-এর জন্য Niantic Wayspot মনোনয়ন পাওয়া গেছে!/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /-এর জন্য Niantic Wayspot মনোনয়নের সিদ্ধান্ত নেওয়া হয়েছে/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /^ধন্যবাদ! .*( |-)এর জন্য Niantic Wayspot Photo পাওয়া গিয়েছে!$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /-এর জন্য Niantic Wayspot মিডিয়া জমা দেওয়ার সিদ্ধান্ত নেওয়া হয়েছে$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /^ধন্যবাদ! .*( |-)এর জন্য Niantic Wayspot সম্পাদনা করার পরামর্শ পাওয়া গেছে!$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /-এর জন্য Niantic Wayspot সম্পাদনায় পরামর্শের সিদ্ধান্ত নেওয়া হয়েছে$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /^ধন্যবাদ! .*( |-)এর জন্য Niantic Wayspot রিপোর্ট পাওয়া গেছে!$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "bn",
  },
  {
    subject: /^Niantic Wayspot রিপোর্ট .*-এর জন্য সিদ্ধান্ত নেওয়া হয়েছে$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "bn",
  },
  //  ---------------------------------------- CZECH [cs] ----------------------------------------
  {
    subject: /^Děkujeme! Přijali jsme nominaci na Niantic Wayspot pro/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Rozhodnutí o nominaci na Niantic Wayspot pro/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Děkujeme! Přijali jsme odvolání proti odmítnutí Niantic Wayspotu/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Rozhodnutí o odvolání proti nominaci na Niantic Wayspot pro/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Děkujeme! Přijali jsme Photo pro Niantic Wayspot/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Rozhodnutí o odeslání obrázku Niantic Wayspotu/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Děkujeme! Přijali jsme návrh na úpravu Niantic Wayspotu pro/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Rozhodnutí o návrhu úpravy Niantic Wayspotu pro/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Děkujeme! Přijali jsme hlášení ohledně Niantic Wayspotu/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "cs",
  },
  {
    subject: /^Rozhodnutí o hlášení v souvislosti s Niantic Wayspotem/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "cs",
  },
  //  ---------------------------------------- GERMAN [de] ----------------------------------------
  {
    subject: /^Danke! Wir haben deinen Vorschlag für den Wayspot/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Entscheidung zum Wayspot-Vorschlag/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Danke! Wir haben deinen Einspruch für den Wayspot/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Entscheidung zum Einspruch für den Wayspot/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Empfangsbestätigung deines eingereichten Portalvorschlags:/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Überprüfung des Portals abgeschlossen:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Trainer [^:]+: Danke, dass du einen PokéStop zur Überprüfung vorgeschlagen hast$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Trainer [^:]+: Dein vorgeschlagener PokéStop ist (zulässig!|nicht zulässig)$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Trainer [^:]+: Die Prüfung deines PokéStop-Vorschlags wurde abgeschlossen:/,
    type: Type.NOMINATION_DECIDED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Fotovorschlag erhalten$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Fotovorschlag (akzeptiert|abgelehnt)$/,
    type: Type.PHOTO_DECIDED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Vorschlag für Bearbeitung erhalten$/,
    type: Type.EDIT_RECEIVED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Vorschlag für Bearbeitung (akzeptiert|abgelehnt)$/,
    type: Type.EDIT_DECIDED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Meldung zu unzulässigen PokéStop\/Arena erhalten$/,
    type: Type.REPORT_RECEIVED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Meldung zu unzulässigen PokéStop\/Arena (akzeptiert|abgelehnt)$/,
    type: Type.REPORT_DECIDED,
    style: Style.POKEMON_GO,
    language: "de",
  },
  {
    subject: /^Danke! Wir haben den Upload Photo für den Wayspot/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Entscheidung zu deinem Upload für den Wayspot/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Danke! Wir haben deinen Änderungsvorschlag für den Wayspot/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Entscheidung zu deinem Änderungsvorschlag für den Wayspot/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Danke! Wir haben deine Meldung für den Wayspot/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Entscheidung zu deiner Meldung für den Wayspot/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "de",
  },
  {
    subject: /^Portalfotovorschlag erhalten/,
    type: Type.PHOTO_RECEIVED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Überprüfung des Portalfotos abgeschlossen/,
    type: Type.PHOTO_DECIDED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Vorschlag für die Änderung eines Portals erhalten/,
    type: Type.EDIT_RECEIVED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Überprüfung des Vorschlags zur Änderung eines Portals abgeschlossen/,
    type: Type.EDIT_DECIDED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Meldung zu ungültigem Ingress-Portal erhalten$/,
    type: Type.REPORT_RECEIVED,
    style: Style.INGRESS,
    language: "de",
  },
  {
    subject: /^Meldung zu ungültigem Ingress-Portal geprüft$/,
    type: Type.REPORT_DECIDED,
    style: Style.INGRESS,
    language: "de",
  },
  //  ---------------------------------------- SPANISH [es] ----------------------------------------
  {
    subject: /^¡Gracias! ¡Hemos recibido la propuesta de Wayspot de Niantic/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^Decisión tomada sobre la propuesta de Wayspot de Niantic/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^¡Gracias! ¡Recurso de Wayspot de Niantic recibido para/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^¡Gracias! ¡Hemos recibido el Photo del Wayspot de Niantic para/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^Decisión tomada sobre el envío de archivo de Wayspot de Niantic para/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^¡Gracias! ¡Propuesta de modificación de Wayspot de Niantic recibida para/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^Decisión tomada sobre la propuesta de modificación del Wayspot de Niantic/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^¡Gracias! ¡Hemos recibido el informe sobre el Wayspot de Niantic/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "es",
  },
  {
    subject: /^Decisión tomada sobre el Wayspot de Niantic/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "es",
  },
  //  ---------------------------------------- FRENCH [fr] ----------------------------------------
  {
    subject: /^Remerciements ! Proposition d’un Wayspot Niantic reçue pour/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Résultat concernant la proposition du Wayspot Niantic/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Remerciements ! Contribution de Wayspot Niantic Photo reçue pour/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Résultat concernant le Wayspot Niantic/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Remerciements ! Proposition de modification de Wayspot Niantic reçue pour/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Résultat concernant la modification du Wayspot Niantic/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Remerciements ! Signalement reçu pour le Wayspot/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "fr",
  },
  {
    subject: /^Résultat concernant le signalement du Wayspot Niantic/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "fr",
  },
  //  ---------------------------------------- HINDI [hi] ----------------------------------------
  {
    subject: /^धन्यवाद! .* के लिए Niantic Wayspot नामांकन प्राप्त हुआ!$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "hi",
  },
  {
    subject: /^Niantic Wayspot का नामांकन .* के लिए तय किया गया$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "hi",
  },
  {
    subject: /के लिए तह Niantic Wayspot मीडिया सबमिशन$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "hi",
  },
  {
    subject: /^धन्यवाद! .* के लिए Niantic Wayspot Photo प्राप्त हुआ!$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "hi",
  },
  {
    subject: /^धन्यवाद! .* के लिए Niantic Wayspot संपादन सुझाव प्राप्त हुआ!$/,
    disambiguate: (email) => {
      const doc = email.getDocument();
      const title = doc?.querySelector("td.em_pbottom.em_blue.em_font_20")?.textContent.trim();
      if (title == "बढ़िया खोज की! आपके वेस्पॉट Photo सबमिशन के लिए धन्यवाद!") {
        return {
          type: Type.PHOTO_RECEIVED,
          style: Style.WAYFARER,
          language: "hi",
        };
      } else if (title?.includes("आपके संपादन हमारे खोजकर्ताओं के समुदाय के लिए सर्वोत्तम संभव अनुभव बनाए रखने में मदद करते हैं।")) {
        return {
          type: Type.EDIT_RECEIVED,
          style: Style.WAYFARER,
          language: "hi",
        };
      } else {
        return null;
      }
    },
  },
  {
    subject: /के लिए Niantic Wayspot संपादन सुझाव प्राप्त हुआ$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "hi",
  },
  {
    subject: /^धन्यवाद! .* के लिए प्राप्त Niantic Wayspot रिपोर्ट!$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "hi",
  },
  {
    subject: /के लिए तय Niantic Wayspot रिपोर्ट$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "hi",
  },
  //  ---------------------------------------- ITALIAN [it] ----------------------------------------
  {
    subject: /^Grazie! Abbiamo ricevuto una candidatura di Niantic Wayspot per/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Proposta di Niantic Wayspot decisa per/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Grazie! Abbiamo ricevuto Photo di Niantic Wayspot per/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Proposta di contenuti multimediali di Niantic Wayspot decisa per/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Grazie! Abbiamo ricevuto il suggerimento di modifica di Niantic Wayspot per/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Suggerimento di modifica di Niantic Wayspot deciso per/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Grazie! Abbiamo ricevuto la segnalazione di Niantic Wayspot per/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "it",
  },
  {
    subject: /^Segnalazione di Niantic Wayspot decisa per/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "it",
  },
  //  ---------------------------------------- JAPANESE [ja] ----------------------------------------
  {
    subject: /^ありがとうございます。 Niantic Wayspotの申請「.*」が受領されました。$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^Niantic Wayspotの申請「.*」が決定しました。$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^ありがとうございます。 Niantic Wayspotに関する申し立て「.*」が受領されました。$/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^Niantic Wayspot「.*」に関する申し立てが決定しました。$/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^ありがとうございます。 Niantic Wayspot Photo「.*」が受領されました。$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^Niantic Wayspotのメディア申請「.*」が決定しました。$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^ありがとうございます。 Niantic Wayspot「.*」の編集提案が受領されました。$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^Niantic Wayspotの編集提案「.*」が決定しました。$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^ありがとうございます。 Niantic Wayspotに関する報告「.*」が受領されました。$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "ja",
  },
  {
    subject: /^Niantic Wayspotの報告「.*」が決定しました$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "ja",
  },
  //  ---------------------------------------- KOREAN [ko] ----------------------------------------
  {
    subject: /^감사합니다! .*에 대한 Niantic Wayspot 후보 신청이 완료되었습니다!$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /에 대한 Niantic Wayspot 후보 결정이 완료됨$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /^감사합니다! .*에 대한 Niantic Wayspot Photo 제출 완료$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /에 대한 Niantic Wayspot 미디어 제안 결정 완료$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /^감사합니다! .*에 대한 Niantic Wayspot 수정이 제안되었습니다!$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /에 대한 Niantic Wayspot 수정 제안 결정 완료$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /^감사합니다! .*에 대한 Niantic Wayspot 보고 접수$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "ko",
  },
  {
    subject: /에 대한 Niantic Wayspot 보고 결정 완료$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "ko",
  },
  //  ---------------------------------------- MARATHI [mr] ----------------------------------------
  {
    subject: /^धन्यवाद! Niantic वेस्पॉट नामांकन .* साठी प्राप्त झाले!$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^Niantic वेस्पॉट नामांकन .* साठी निश्चित केले$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^धन्यवाद! Niantic वेस्पॉट आवाहन .* साठी प्राप्त झाले!$/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^तुमचे Niantic वेस्पॉट आवाहन .* साठी निश्चित करण्यात आले आहे$/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^धन्यवाद! .* साठी Niantic वेस्पॉट Photo प्राप्त झाले!$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /साठी Niantic वेस्पॉट मीडिया सबमिशनचा निर्णय घेतला$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^धन्यवाद! Niantic वेस्पॉट संपादन सूचना .* साठी प्राप्त झाली!$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^Niantic वेस्पॉट संपादन सूचना .* साठी निश्चित केली$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /^धन्यवाद! .* साठी Niantic वेस्पॉट अहवाल प्राप्त झाला!$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "mr",
  },
  {
    subject: /साठी Niantic वेस्पॉट अहवाल निश्चित केला$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "mr",
  },
  //  ---------------------------------------- DUTCH [nl] ----------------------------------------
  {
    subject: /^Bedankt! Niantic Wayspot-nominatie ontvangen voor/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Besluit over Niantic Wayspot-nominatie voor/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Bedankt! Niantic Wayspot-Photo ontvangen voor/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Besluit over Niantic Wayspot-media-inzending voor/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Bedankt! Niantic Wayspot-bewerksuggestie ontvangen voor/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Besluit over Niantic Wayspot-bewerksuggestie voor/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Bedankt! Melding van Niantic Wayspot .* ontvangen!$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "nl",
  },
  {
    subject: /^Besluit over Niantic Wayspot-melding voor/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "nl",
  },
  //  ---------------------------------------- NORWEGIAN [no] ----------------------------------------
  {
    subject: /^Takk! Vi har mottatt Niantic Wayspot-nominasjonen for/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^En avgjørelse er tatt for Niantic Wayspot-nominasjonen for/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^Takk! Vi har mottatt Niantic Wayspot-klagen for/,
    type: Type.NOMINATION_APPEAL_RECEIVED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^En avgjørelse er tatt for Niantic Wayspot-klagen for/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^Takk! Vi har mottatt Photo for Niantic-Wayspot-en/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^Takk! Vi har mottatt endringsforslaget for Niantic Wayspot-en/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^Takk! Vi har mottatt Niantic Wayspot-rapporten for/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^En avgjørelse er tatt for Niantic Wayspot-medieinnholdet som er sendt inn for/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^En avgjørelse er tatt for endringsforslaget for Niantic Wayspot-en/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "no",
  },
  {
    subject: /^En avgjørelse er tatt for Niantic Wayspot-rapporten for/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "no",
  },
  //  ---------------------------------------- POLISH [pl] ----------------------------------------
  {
    subject: /^Dziękujemy! Odebrano nominację Wayspotu/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Podjęto decyzję na temat nominacji Wayspotu/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Dziękujemy! Odebrano materiały Photo Wayspotu Niantic/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Decyzja na temat zgłoszenia materiałów do Wayspotu Niantic/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Dziękujemy! Odebrano sugestię zmiany Wayspotu Niantic/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Podjęto decyzję na temat sugestii edycji Wayspotu Niantic/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Dziękujemy! Odebrano raport dotyczący Wayspotu Niantic/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "pl",
  },
  {
    subject: /^Podjęto decyzję odnośnie raportu dotyczącego Wayspotu Niantic/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "pl",
  },
  //  ---------------------------------------- PORTUGUESE [pt] ----------------------------------------
  {
    subject: /^Agradecemos a sua indicação para o Niantic Wayspot/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Decisão sobre a indicação do Niantic Wayspot/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Agradecemos o envio de Photo para o Niantic Wayspot/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Decisão sobre o envio de mídia para o Niantic Wayspot/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Agradecemos a sua sugestão de edição para o Niantic Wayspot/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Decisão sobre a sugestão de edição do Niantic Wayspot/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Agradecemos o envio da denúncia referente ao Niantic Wayspot/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "pt",
  },
  {
    subject: /^Decisão sobre a denúncia referente ao Niantic Wayspot/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "pt",
  },
  //  ---------------------------------------- RUSSIAN [ru] ----------------------------------------
  {
    subject: /^Спасибо! Номинация Niantic Wayspot для .* получена!$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Вынесено решение по номинации Niantic Wayspot для/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Спасибо! Получено: Photo Niantic Wayspot для/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Вынесено решение по предложению по файлу для/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Спасибо! Предложение по изменению Niantic Wayspot для/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Вынесено решение по предложению по изменению Niantic Wayspot для/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Спасибо! Жалоба на Niantic Wayspot для/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "ru",
  },
  {
    subject: /^Вынесено решение по жалобе на Niantic Wayspot для/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "ru",
  },
  //  ---------------------------------------- SWEDISH [sv] ----------------------------------------
  {
    subject: /^Tack! Niantic Wayspot-nominering har tagits emot för/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Niantic Wayspot-nominering har beslutats om för/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Din Niantic Wayspot-överklagan har beslutats om för/,
    type: Type.NOMINATION_APPEAL_DECIDED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Tack! Niantic Wayspot Photo togs emot för/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Niantic Wayspot-medieinlämning har beslutats om för/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Tack! Niantic Wayspot-redigeringsförslag har tagits emot för/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Niantic Wayspot-redigeringsförslag har beslutats om för/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Tack! Niantic Wayspot-rapport har tagits emot för/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "sv",
  },
  {
    subject: /^Niantic Wayspot-rapport har beslutats om för/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "sv",
  },
  //  ---------------------------------------- TAMIL [ta] ----------------------------------------
  {
    subject: /^நன்றி! .* -க்கான Niantic Wayspot பரிந்துரை பெறப்பட்டது!!$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /-க்கான Niantic Wayspot பணிந்துரை பரிசீலிக்கப்பட்டது.$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /^நன்றி! .* -க்கான Niantic Wayspot Photo பெறப்பட்டது!$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /-க்கான Niantic Wayspot மீடியா சமர்ப்பிப்பு பரிசீலிக்கப்பட்டது.$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /^நன்றி! .* -க்கான Niantic Wayspot திருத்த பரிந்துரை பெறப்பட்டது!$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /-க்கான Niantic Wayspot திருத்த பரிந்துரை பரிசீலிக்கப்பட்டது$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /^நன்றி! .* -க்கான Niantic Wayspot புகார் பெறப்பட்டது!$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "ta",
  },
  {
    subject: /-க்கான Niantic Wayspot புகார் பரிசீலிக்கப்பட்டது!$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "ta",
  },
  //  ---------------------------------------- TELUGU [te] ----------------------------------------
  {
    subject: /^ధన్యవాదాలు! .* కు Niantic Wayspot నామినేషన్ అందుకున్నాము!$/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /కొరకు Niantic వేస్పాట్ నామినేషన్‌‌పై నిర్ణయం$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /^ధన్యవాదాలు! .* కొరకు Niantic Wayspot Photo అందుకున్నాము!$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /కొరకు Niantic వేస్పాట్ మీడియా సమర్పణపై నిర్ణయం$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /^ధన్యవాదాలు! మీ వేస్పాట్ .* ఎడిట్ సూచనకై ధన్యవాదాలు!$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /కొరకు నిర్ణయించబడిన Niantic వేస్పాట్ సూచన$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /^ధన్యవాదాలు! .* కొరకు Niantic వేస్పాట్ నామినేషన్ అందుకున్నాము!$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "te",
  },
  {
    subject: /కొరకు నిర్ణయించబడిన Niantic వేస్పాట్ రిపోర్ట్$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "te",
  },
  //  ---------------------------------------- THAI [th] ----------------------------------------
  {
    subject: /^ขอบคุณ! เราได้รับการเสนอสถานที่ Niantic Wayspot สำหรับ/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ผลการตัดสินการเสนอสถานที่ Niantic Wayspot สำหรับ/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ขอบคุณ! ได้รับ Niantic Wayspot Photo สำหรับ/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ผลการตัดสินการส่งมีเดีย Niantic Wayspot สำหรับ/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ขอบคุณ! เราได้รับคำแนะนำการแก้ไข Niantic Wayspot สำหรับ/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ผลการตัดสินคำแนะนำการแก้ไข Niantic Wayspot สำหรับ/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ขอบคุณ! เราได้รับการรายงาน Niantic Wayspot สำหรับ/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "th",
  },
  {
    subject: /^ผลตัดสินการรายงาน Niantic Wayspot สำหรับ/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "th",
  },
  //  ---------------------------------------- CHINESE [zh] ----------------------------------------
  {
    subject: /^感謝你！ 我們已收到 Niantic Wayspot 候選/,
    type: Type.NOMINATION_RECEIVED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^社群已對 Niantic Wayspot 候選 .* 做出決定$/,
    type: Type.NOMINATION_DECIDED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^感謝你！ 我們已收到 .* 的 Niantic Wayspot Photo！$/,
    type: Type.PHOTO_RECEIVED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^社群已對你為 .* 提交的 Niantic Wayspot 媒體做出決定$/,
    type: Type.PHOTO_DECIDED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^感謝你！ 我們已收到 .* 的 Niantic Wayspot 編輯建議！$/,
    type: Type.EDIT_RECEIVED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^社群已對 .* 的 Niantic Wayspot 編輯建議做出決定$/,
    type: Type.EDIT_DECIDED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^感謝你！ 我們已收到 .* 的 Niantic Wayspot 報告！$/,
    type: Type.REPORT_RECEIVED,
    style: Style.WAYFARER,
    language: "zh",
  },
  {
    subject: /^Niantic 已對 .* 的 Wayspot 報告做出決定$/,
    type: Type.REPORT_DECIDED,
    style: Style.WAYFARER,
    language: "zh",
  },
];

  // -------------------------------------------------------------------------
  // SUPPLEMENTAL TEMPLATES -- not from upstream OPR-Tools.
  //
  // The upstream templates.ts (ported above, unmodified) has no RECON-style
  // (current "Spatial" era) templates for: nomination decisions, photo
  // decisions, or Spatial-branded appeal emails. Your gmail_wayspot_export.py
  // had already reverse-engineered these from real inbox testing, so they're
  // carried over here rather than silently losing decision-matching for
  // every current-era submission. Each entry below is commented with where
  // it came from.
  // -------------------------------------------------------------------------
  const SUPPLEMENTAL_TEMPLATES = [
    // Confirmed real subject (gmail_wayspot_export.py NOMINATION_DECIDED_QUERY)
    {
      subject: /^Niantic Spatial Wayspot nomination decided for/,
      type: Type.NOMINATION_DECIDED,
      style: Style.RECON,
      language: "en",
    },
    // Confirmed real subject (gmail_wayspot_export.py NOMINATION_DECIDED_QUERY,
    // note: "Decision on you Recon Nomination" -- "you" not "your", as observed)
    {
      subject: /^Decision on you Recon Nomination,/,
      type: Type.NOMINATION_DECIDED,
      style: Style.RECON,
      language: "en",
    },
    // Confirmed real subject (gmail_wayspot_export.py PHOTO_DECIDED_QUERY)
    {
      subject: /media submission decided for/i,
      type: Type.PHOTO_DECIDED,
      style: Style.RECON,
      language: "en",
    },
    // Confirmed real subject (gmail_wayspot_export.py APPEAL_RECEIVED_QUERY).
    // Spatial-branded nomination/photo appeal -- which of the two it targets
    // is only knowable from the body, so classification alone can't tell;
    // wst-business-logic.js resolves the real target via parseAppealReceived().
    {
      subject: /^Thanks! Niantic Spatial Wayspot appeal received/,
      type: Type.NOMINATION_APPEAL_RECEIVED,
      style: Style.RECON,
      language: "en",
    },
    // Confirmed real subject (gmail_wayspot_export.py APPEAL_EDIT_RECEIVED_QUERY)
    {
      subject: /^Thanks! Niantic Spatial Wayspot title edit appeal received for/,
      type: Type.EDIT_APPEAL_RECEIVED,
      style: Style.RECON,
      language: "en",
    },
    // *** BEST-EFFORT / UNCONFIRMED ***
    // gmail_wayspot_export.py's own docstring flags this as a guessed subject
    // line -- no real example existed when it was written. Carried over
    // as-is, same caveat applies here.
    {
      subject: /^Your Niantic Spatial Wayspot appeal has been decided/,
      type: Type.NOMINATION_APPEAL_DECIDED,
      style: Style.RECON,
      language: "en",
    },
    // Confirmed real subjects (Dutch legacy Wayfarer) -- found via a real
    // user inbox. Upstream's Dutch templates cover received/decided for
    // nominations/photos/edits/reports, but have no appeal templates at
    // all, and the one Dutch NOMINATION_DECIDED template upstream does have
    // ("Besluit over Niantic Wayspot-nominatie voor...") doesn't match this
    // wording -- these appear to be a different/older subject-line
    // generation than what upstream's template was modeled on.
    {
      subject: /^Beslissing over je Wayfarer-nominatie,/,
      type: Type.NOMINATION_DECIDED,
      style: Style.WAYFARER,
      language: "nl",
    },
    {
      subject: /^Bedankt! Niantic Wayspot-bezwaar ontvangen voor/,
      type: Type.NOMINATION_APPEAL_RECEIVED,
      style: Style.WAYFARER,
      language: "nl",
    },
    {
      subject: /^Niantic heeft een besluit genomen over je bezwaar voor/,
      type: Type.NOMINATION_APPEAL_DECIDED,
      style: Style.WAYFARER,
      language: "nl",
    },
  ];

  TEMPLATES.push(...SUPPLEMENTAL_TEMPLATES);

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  global.OPREmail = {
    Type,
    Style,
    Email,
    parseMIME,
    extractEmail,
    decodeBodyUsingCTE,
    stripDiacritics,
    TEMPLATES,
    errors: {
      InvalidEmailFormatError,
      NotImplementedError,
      InvalidContentTypeError,
      HeaderNotFoundError,
      NoMatchingTemplateError,
      DisambiguationFailedError,
    },
  };
})(window);
