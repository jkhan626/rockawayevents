// netlify/functions/pending.js  ->  GET /api/pending?key=...
// Lists Pending rows from the new DB for the admin page. Key-gated, never
// cached, never indexed.

const N = require("./lib/notion");
const { requireKey, privateJson } = require("./lib/auth");
const { parseTimeStart } = require("./lib/events-core");

// Same Event shape /api/events returns, plus the submitter fields the admin
// page needs to judge a submission.
function simplify(page) {
  const dp = N.getDateParts(page, "Date");
  const ep = N.getDateParts(page, "End Date");
  const time = N.getText(page, "Time");
  const recurringRaw = N.getSelect(page, "Recurring") || "None";
  return {
    id: page.id,
    event: N.getTitle(page, "Event"),
    date: dp.date,
    dateEnd: ep.date || dp.end || null,
    time,
    timeStart: dp.time || parseTimeStart(time),
    venue: N.getText(page, "Venue"),
    address: N.getText(page, "Address"),
    category: N.getMulti(page, "Category"),
    cost: N.getText(page, "Cost"),
    free: N.getCheckbox(page, "Free"),
    url: N.getUrl(page, "URL"),
    instagram: N.getUrl(page, "Instagram"),
    image: N.getUrl(page, "Image"),
    description: N.getText(page, "Description"),
    source: N.getSelect(page, "Source") || "Community",
    featured: N.getCheckbox(page, "Featured"),
    recurring: ["Weekly", "Monthly"].includes(recurringRaw) ? recurringRaw : "None",
    days: N.getMulti(page, "Days"),
    submitterName: N.getText(page, "Submitter Name"),
    submitterEmail: N.getEmail(page, "Submitter Email"),
    submitted: N.getCreatedTime(page, "Submitted") || page.created_time || null,
  };
}

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const denied = requireKey(q.key);
  if (denied) return denied;

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return privateJson(500, { error: "Server not configured: NOTION_TOKEN is missing." });
  }

  try {
    const pages = await N.queryAll(
      N.NEW_DB_ID,
      {
        filter: { property: "Status", select: { equals: "Pending" } },
        // Oldest submissions first, so the queue is worked front to back.
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
      },
      token
    );
    const events = pages.map(simplify);
    return privateJson(200, {
      updated: new Date().toISOString(),
      today: N.todayET(),
      count: events.length,
      events,
    });
  } catch (err) {
    console.error("pending: " + String((err && err.stack) || err));
    return privateJson(502, {
      error: "Failed to read Notion",
      detail: (err && err.message) || String(err),
    });
  }
};

// exported for tests
exports.simplify = simplify;
