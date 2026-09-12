// netlify/functions/submission-created.js
// Netlify calls this function by name on EVERY Netlify Forms submission. The
// body is { payload: { data: {...fields}, form_name, ... } }. We only handle
// form_name === "event-submit" and create a Pending row in the new Notion DB.
//
// This handler ALWAYS returns 200. A non-2xx makes Netlify retry the webhook,
// which would either duplicate the Notion row or retry forever on bad input;
// failures are logged to the function log instead so Jamal can see them.

const N = require("./lib/notion");
const { sendEmail, templates } = require("./lib/email");

const FORM_NAME = "event-submit";

// Field length caps, so a junk or abusive submission cannot bloat the DB.
// Notion itself rejects rich_text over 2000 chars per block.
const CAPS = {
  event: 200,
  time: 120,
  venue: 200,
  address: 300,
  cost: 100,
  description: 1900,
  url: 500,
  instagram: 500,
  image: 500,
  name: 120,
  email: 200,
};

const ok = (body) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

/* ---- normalizers ------------------------------------------------------- */

function str(v, cap) {
  if (v == null) return "";
  const s = String(Array.isArray(v) ? v.join(", ") : v).trim();
  return cap ? s.slice(0, cap) : s;
}

// A multi-value field arrives either as an array (multi-select / checkbox group)
// or as a comma-joined string, depending on how the form is built.
function list(v) {
  if (v == null) return [];
  const raw = Array.isArray(v) ? v : String(v).split(",");
  const out = [];
  for (const item of raw) {
    const s = String(item).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// Keep only values that already exist as options in the Notion multi_select,
// matched case-insensitively. Unknown values are dropped rather than created,
// so a submitter cannot invent categories.
function pickAllowed(values, allowed) {
  const byLower = new Map(allowed.map((a) => [a.toLowerCase(), a]));
  const out = [];
  for (const v of values) {
    const hit = byLower.get(String(v).toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

// Netlify checkboxes post "on"; JSON-built forms may post true / "true" / "yes".
function truthy(v) {
  if (v === true) return true;
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return s === "on" || s === "true" || s === "yes" || s === "1" || s === "checked";
}

// Accept a full http(s) URL, or add https:// to a bare domain. Anything else
// (javascript:, mailto:, gibberish) is dropped: Notion rejects bad url values.
function cleanUrl(v, cap) {
  let s = str(v, cap);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(s)) s = "https://" + s;
    else return null;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString().slice(0, cap || 500);
  } catch {
    return null;
  }
}

function cleanEmail(v) {
  const s = str(v, CAPS.email).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s : null;
}

// Map Mon/Monday/mon. to the "Mon" option the Days multi_select uses.
function cleanDays(v) {
  const out = [];
  for (const d of list(v)) {
    const k = String(d).slice(0, 3).toLowerCase();
    const hit = N.DAY_NAMES.find((n) => n.toLowerCase() === k);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/* ---- field mapping ----------------------------------------------------- */

// Turn raw form data into a Notion properties object, or return { error }.
function buildProperties(data) {
  const event = str(data.event, CAPS.event);
  if (!event) return { error: "missing required field: event" };

  const date = str(data.date).slice(0, 10);
  const endDate = str(data.endDate || data["end-date"] || data.end_date).slice(0, 10);
  const validDate = N.isValidYmd(date) ? date : null;
  // An End Date only makes sense with a start, and must not precede it.
  const validEnd =
    validDate && N.isValidYmd(endDate) && endDate >= validDate ? endDate : null;

  const recurringRaw = str(data.recurring);
  const recurring = ["Weekly", "Monthly"].includes(recurringRaw) ? recurringRaw : "None";

  const category = pickAllowed(list(data.category), N.CATEGORIES);
  const days = cleanDays(data.days);

  const props = {
    Event: N.write.title(event),
    Status: N.write.select("Pending"),
    Source: N.write.select("Community"),
    Recurring: N.write.select(recurring),
    Time: N.write.rich(str(data.time, CAPS.time)),
    Venue: N.write.rich(str(data.venue, CAPS.venue)),
    Address: N.write.rich(str(data.address, CAPS.address)),
    Cost: N.write.rich(str(data.cost, CAPS.cost)),
    Description: N.write.rich(str(data.description, CAPS.description)),
    Free: N.write.checkbox(truthy(data.free)),
    Category: N.write.multi(category),
    Days: N.write.multi(days),
    URL: N.write.url(cleanUrl(data.url, CAPS.url)),
    Instagram: N.write.url(cleanUrl(data.instagram, CAPS.instagram)),
    Image: N.write.url(cleanUrl(data.image, CAPS.image)),
    "Submitter Name": N.write.rich(str(data.name, CAPS.name)),
    "Submitter Email": N.write.email(cleanEmail(data.email)),
  };

  // Only send Date at all when it parsed: an invalid string would 400 the API.
  if (validDate) props.Date = N.write.date(validDate);
  if (validEnd) props["End Date"] = N.write.date(validEnd);

  const submitterEmail = cleanEmail(data.email);
  const submitterName = str(data.name, CAPS.name);

  return {
    props,
    event,
    date: validDate,
    dateEnd: validEnd,
    recurring,
    time: str(data.time, CAPS.time),
    venue: str(data.venue, CAPS.venue),
    address: str(data.address, CAPS.address),
    category: category.join(", "),
    cost: str(data.cost, CAPS.cost),
    free: truthy(data.free),
    url: cleanUrl(data.url, CAPS.url),
    instagram: cleanUrl(data.instagram, CAPS.instagram),
    image: cleanUrl(data.image, CAPS.image),
    description: str(data.description, CAPS.description),
    days: days.join(", "),
    submitterName,
    submitterEmail,
  };
}

// Fire the two notification emails. Never lets an email failure propagate:
// each send is independently try/caught, and the whole thing is fire-and-forget
// from the handler's point of view (awaited only so logs land before the
// function is frozen, not because a failure should change the 200 response).
async function notify(built, pageId) {
  const notifyTo = process.env.NOTIFY_EMAIL || "jamalknyc@gmail.com";
  const notionUrl = "https://notion.so/" + String(pageId).replace(/-/g, "");

  try {
    await sendEmail({
      to: notifyTo,
      subject: "New event submitted: " + built.event + " (" + (built.date || "no date") + ")",
      html: templates.newSubmission({
        notionUrl,
        fields: [
          { label: "Event", value: built.event },
          { label: "Date", value: built.date },
          { label: "End Date", value: built.dateEnd },
          { label: "Recurring", value: built.recurring },
          { label: "Days", value: built.days },
          { label: "Time", value: built.time },
          { label: "Venue", value: built.venue },
          { label: "Address", value: built.address },
          { label: "Category", value: built.category },
          { label: "Cost", value: built.cost },
          { label: "Free", value: built.free ? "Yes" : "" },
          { label: "URL", value: built.url },
          { label: "Instagram", value: built.instagram },
          { label: "Image", value: built.image },
          { label: "Description", value: built.description },
          { label: "Submitter Name", value: built.submitterName },
          { label: "Submitter Email", value: built.submitterEmail },
        ],
      }),
    });
  } catch (err) {
    console.error("submission-created: notify email threw: " + String((err && err.message) || err));
  }

  if (built.submitterEmail) {
    try {
      await sendEmail({
        to: built.submitterEmail,
        subject: "Thanks, we got your event",
        replyTo: "hello@rockawayevents.org",
        html: templates.submissionConfirmation({ event: built.event, date: built.date }),
      });
    } catch (err) {
      console.error("submission-created: confirmation email threw: " + String((err && err.message) || err));
    }
  }
}

/* ---- handler ----------------------------------------------------------- */

exports.handler = async (event) => {
  let payload = {};
  try {
    payload = JSON.parse((event && event.body) || "{}");
  } catch (err) {
    console.error("submission-created: unparseable body", String(err));
    return ok({ ignored: true, reason: "unparseable body" });
  }

  const sub = payload.payload || payload;
  const formName = sub.form_name || sub.formName || "";
  if (formName !== FORM_NAME) {
    console.log("submission-created: ignoring form " + JSON.stringify(formName));
    return ok({ ignored: true, form: formName });
  }

  const data = sub.data || {};
  // Netlify's honeypot means a filled bot-field should never reach here, but
  // belt and braces: a filled honeypot is a bot, so drop it silently.
  if (str(data["bot-field"]) || str(data.botField)) {
    console.log("submission-created: honeypot filled, dropping");
    return ok({ ignored: true, reason: "honeypot" });
  }

  const built = buildProperties(data);
  if (built.error) {
    console.error("submission-created: " + built.error, JSON.stringify(data).slice(0, 500));
    return ok({ ignored: true, reason: built.error });
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    // Log loudly: the submission is in Netlify Forms, so nothing is lost, but
    // it will not appear in Notion until the env var is set.
    console.error(
      "submission-created: NOTION_TOKEN missing, could not file: " + built.event
    );
    return ok({ ok: false, reason: "NOTION_TOKEN missing" });
  }

  try {
    const page = await N.createPage(N.NEW_DB_ID, built.props, token);
    console.log(
      "submission-created: created Pending page " + page.id + " for " + built.event
    );
    await notify(built, page.id);
    return ok({ ok: true, id: page.id });
  } catch (err) {
    console.error(
      "submission-created: Notion create failed for " +
        built.event +
        ": " +
        String((err && err.message) || err)
    );
    return ok({ ok: false, reason: "notion create failed" });
  }
};

// exported for tests
exports.buildProperties = buildProperties;
exports.cleanUrl = cleanUrl;
exports.cleanDays = cleanDays;
exports.truthy = truthy;
exports.pickAllowed = pickAllowed;
