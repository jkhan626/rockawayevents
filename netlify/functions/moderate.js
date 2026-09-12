// netlify/functions/moderate.js  ->  POST /api/moderate
// Body: { id, action: "approve" | "reject", key, edits?: {...} }
//
// Flips a Pending row's Status, optionally patching corrected fields in the
// same PATCH so Jamal can fix a submitter's typo and approve in one click.
// Key-gated, never cached, never indexed.

const N = require("./lib/notion");
const { requireKey, privateJson } = require("./lib/auth");

const ACTIONS = {
  approve: "Approved",
  reject: "Rejected",
};

// Same caps as the public submission path, so an edit cannot smuggle in a
// 50 KB description that the submit form would have rejected.
const CAPS = {
  event: 200,
  time: 120,
  venue: 200,
  address: 300,
  cost: 100,
  description: 1900,
  url: 500,
  instagram: 500,
};

const trim = (v, cap) => String(v == null ? "" : v).trim().slice(0, cap);

function cleanUrl(v, cap) {
  let s = trim(v, cap);
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(s)) s = "https://" + s;
    else return null;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString().slice(0, cap);
  } catch {
    return null;
  }
}

// Build the properties patch from an `edits` object. Only keys actually present
// are touched, so omitting a field leaves Notion's value alone. A key present
// but empty clears that field, which is how you delete a bad URL.
function editProperties(edits) {
  const props = {};
  if (!edits || typeof edits !== "object") return props;
  const has = (k) => Object.prototype.hasOwnProperty.call(edits, k);

  if (has("event")) {
    const v = trim(edits.event, CAPS.event);
    // Never blank a title: an untitled row is invisible everywhere downstream.
    if (v) props.Event = N.write.title(v);
  }
  if (has("date")) {
    const v = trim(edits.date).slice(0, 10);
    if (!v) props.Date = N.write.date(null);
    else if (N.isValidYmd(v)) props.Date = N.write.date(v);
    // An unparseable date is ignored rather than written as null, so a typo in
    // the admin form cannot silently wipe a good date.
  }
  if (has("time")) props.Time = N.write.rich(trim(edits.time, CAPS.time));
  if (has("venue")) props.Venue = N.write.rich(trim(edits.venue, CAPS.venue));
  if (has("address")) props.Address = N.write.rich(trim(edits.address, CAPS.address));
  if (has("description")) {
    props.Description = N.write.rich(trim(edits.description, CAPS.description));
  }
  if (has("cost")) props.Cost = N.write.rich(trim(edits.cost, CAPS.cost));
  if (has("url")) props.URL = N.write.url(cleanUrl(edits.url, CAPS.url));
  if (has("instagram")) {
    props.Instagram = N.write.url(cleanUrl(edits.instagram, CAPS.instagram));
  }
  if (has("category")) {
    const raw = Array.isArray(edits.category)
      ? edits.category
      : String(edits.category || "").split(",");
    const byLower = new Map(N.CATEGORIES.map((c) => [c.toLowerCase(), c]));
    const picked = [];
    for (const c of raw) {
      const hit = byLower.get(String(c).trim().toLowerCase());
      if (hit && !picked.includes(hit)) picked.push(hit);
    }
    props.Category = N.write.multi(picked);
  }
  return props;
}

exports.handler = async (event) => {
  const method = (event && event.httpMethod) || "GET";
  if (method !== "POST") {
    return privateJson(405, { error: "Use POST" });
  }

  let body = {};
  try {
    body = JSON.parse((event && event.body) || "{}");
  } catch {
    return privateJson(400, { error: "Body must be JSON" });
  }

  // Auth before anything else, so an unauthenticated caller learns nothing
  // about which ids exist or which actions are valid.
  const denied = requireKey(body.key);
  if (denied) return denied;

  const id = trim(body.id, 100);
  const action = trim(body.action, 20).toLowerCase();
  const status = ACTIONS[action];
  if (!id) return privateJson(400, { error: "Missing id" });
  if (!status) {
    return privateJson(400, {
      error: "action must be one of: " + Object.keys(ACTIONS).join(", "),
    });
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return privateJson(500, { error: "Server not configured: NOTION_TOKEN is missing." });
  }

  // Edits only make sense on the way to Approved; rejecting just sets Status.
  const props =
    action === "approve" ? editProperties(body.edits) : {};
  props.Status = N.write.select(status);

  try {
    await N.updatePage(id, props, token);
    console.log("moderate: " + action + " " + id + " (" + Object.keys(props).join(",") + ")");
    return privateJson(200, {
      ok: true,
      id,
      status,
      patched: Object.keys(props).filter((k) => k !== "Status"),
    });
  } catch (err) {
    console.error("moderate: " + String((err && err.stack) || err));
    const upstream = err && err.status;
    return privateJson(upstream === 404 ? 404 : 502, {
      error: "Failed to update Notion",
      detail: (err && err.message) || String(err),
    });
  }
};

// exported for tests
exports.editProperties = editProperties;
