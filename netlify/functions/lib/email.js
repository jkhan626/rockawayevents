// netlify/functions/lib/email.js
// Thin Resend REST wrapper. Zero npm dependencies: Node 20's global fetch only.
// Every call degrades gracefully: with no RESEND_API_KEY set (or on any
// upstream failure) we log and return { ok: false }, we never throw. Callers
// must never let an email failure change the response they send the browser.

const RESEND_API = "https://api.resend.com";

const DEFAULT_FROM = "Rockaway Events <hello@rockawayevents.org>";

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// POST /emails. `to` may be a string or an array of strings.
async function sendEmail({ to, subject, html, text, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log("email: RESEND_API_KEY missing, skipping send: " + subject);
    return { ok: false, skipped: true };
  }

  const body = {
    from: process.env.EMAIL_FROM || DEFAULT_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  if (text) body.text = text;
  if (replyTo) body.reply_to = replyTo;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(RESEND_API + "/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("email: Resend send failed " + res.status + ": " + JSON.stringify(data).slice(0, 500));
      return { ok: false, error: (data && data.message) || "Resend " + res.status };
    }
    return { ok: true, id: data && data.id };
  } catch (err) {
    console.error("email: send threw: " + String((err && err.message) || err));
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// POST /audiences/{id}/contacts. No-op (not a failure) when Resend isn't
// configured for contacts yet, so the weekly-list signup never 500s.
async function addContact({ email, firstName }) {
  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!apiKey || !audienceId) {
    console.log("email: RESEND_API_KEY or RESEND_AUDIENCE_ID missing, skipping addContact");
    return { ok: false, skipped: true };
  }

  const body = { email, unsubscribed: false };
  if (firstName) body.first_name = firstName;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(RESEND_API + "/audiences/" + audienceId + "/contacts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("email: Resend addContact failed " + res.status + ": " + JSON.stringify(data).slice(0, 500));
      return { ok: false, error: (data && data.message) || "Resend " + res.status };
    }
    return { ok: true, id: data && data.id };
  } catch (err) {
    console.error("email: addContact threw: " + String((err && err.message) || err));
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

/* ---- templates ----------------------------------------------------------
 * Plain inline-styled HTML. Sand background, ink text, ocean links, matching
 * the site's light "sand and ocean" palette. No emojis, no em dashes.
 */

const SAND = "#FBF6EC";
const INK = "#16242F";
const OCEAN = "#1F6F8B";
const MUTED = "#5C6670";

function wrap(bodyHtml) {
  return (
    '<div style="background:' + SAND + ";padding:24px;font-family:Georgia,'Times New Roman',serif;" +
    'color:' + INK + ';">' +
    '<div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #E6DCC8;' +
    'border-radius:8px;padding:28px;">' +
    bodyHtml +
    '<p style="margin-top:28px;padding-top:16px;border-top:1px solid #E6DCC8;font-size:12px;color:' +
    MUTED +
    ';">Rockaway Events &mdash; <a href="https://rockawayevents.org" style="color:' +
    OCEAN +
    ';">rockawayevents.org</a></p>' +
    "</div></div>"
  );
}

function link(url, label) {
  return '<a href="' + escapeHtml(url) + '" style="color:' + OCEAN + ';">' + escapeHtml(label || url) + "</a>";
}

const templates = {
  // New submission notice to Jamal.
  newSubmission({ fields, notionUrl }) {
    const rows = fields
      .filter((f) => f.value)
      .map(
        (f) =>
          '<tr><td style="padding:4px 12px 4px 0;color:' +
          MUTED +
          ';font-size:13px;white-space:nowrap;vertical-align:top;">' +
          escapeHtml(f.label) +
          '</td><td style="padding:4px 0;font-size:14px;">' +
          escapeHtml(f.value) +
          "</td></tr>"
      )
      .join("");
    return wrap(
      '<h2 style="margin:0 0 16px;font-size:18px;">New event submitted</h2>' +
        '<table style="border-collapse:collapse;width:100%;">' +
        rows +
        "</table>" +
        '<p style="margin-top:20px;">' +
        link("https://rockawayevents.org/admin/", "Review in the admin panel") +
        "<br>" +
        link(notionUrl, "Open in Notion") +
        "</p>"
    );
  },

  // Confirmation to the submitter.
  submissionConfirmation({ event, date }) {
    return wrap(
      '<h2 style="margin:0 0 16px;font-size:18px;">Thanks, we got your event</h2>' +
        '<p style="font-size:14px;line-height:1.6;">We review every submission before it goes live, ' +
        "usually within a day.</p>" +
        '<p style="font-size:14px;line-height:1.6;"><strong>' +
        escapeHtml(event) +
        "</strong>" +
        (date ? "<br>" + escapeHtml(date) : "") +
        "</p>"
    );
  },

  // Approval notice to the submitter.
  eventApproved({ event, date, url }) {
    return wrap(
      '<h2 style="margin:0 0 16px;font-size:18px;">Your event is live</h2>' +
        '<p style="font-size:14px;line-height:1.6;"><strong>' +
        escapeHtml(event) +
        "</strong>" +
        (date ? "<br>" + escapeHtml(date) : "") +
        "</p>" +
        '<p style="font-size:14px;line-height:1.6;">It is now live on ' +
        link(url, "rockawayevents.org") +
        ".</p>"
    );
  },
};

module.exports = { sendEmail, addContact, escapeHtml, templates };
