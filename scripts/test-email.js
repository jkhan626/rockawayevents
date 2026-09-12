// scripts/test-email.js — offline test for Resend wiring. Not committed.
// Monkeypatches global.fetch so nothing real is hit: Notion calls return a
// canned page, Resend calls are captured and inspected.

const assert = require("assert");

let calls = [];
function stubFetch(url, opts) {
  const u = String(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url: u, body });

  if (u.includes("api.notion.com")) {
    if (opts.method === "POST" && u.endsWith("/pages")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ id: "page-123", properties: {} }),
      });
    }
    if (opts.method === "PATCH") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          id: "page-123",
          properties: {
            Event: { title: [{ plain_text: "Beach Yoga" }] },
            Date: { date: { start: "2026-10-04" } },
            "Submitter Email": { email: "submitter@example.com" },
          },
        }),
      });
    }
  }

  if (u.includes("api.resend.com/emails")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ id: "email-abc" }),
    });
  }

  if (u.includes("api.resend.com/audiences")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ id: "contact-abc" }),
    });
  }

  throw new Error("unexpected fetch: " + u);
}

async function withFetch(fn) {
  calls = [];
  const real = global.fetch;
  global.fetch = stubFetch;
  try {
    return await fn();
  } finally {
    global.fetch = real;
  }
}

function freshHandler(path) {
  delete require.cache[require.resolve(path)];
  return require(path);
}

async function run() {
  process.env.NOTION_TOKEN = "fake";

  // 1) submission-created WITHOUT RESEND_API_KEY: still 200, no Resend calls.
  delete process.env.RESEND_API_KEY;
  await withFetch(async () => {
    const mod = freshHandler("../netlify/functions/submission-created.js");
    const res = await mod.handler({
      body: JSON.stringify({
        payload: {
          form_name: "event-submit",
          data: {
            event: "Beach Yoga",
            date: "2026-10-04",
            category: "Run & Fitness,Surf & Beach",
            free: "on",
            url: "example.com/yoga",
            email: "submitter@example.com",
            name: "Sasha",
          },
        },
      }),
    });
    assert.strictEqual(res.statusCode, 200, "submission-created (no key) should be 200");
    const resendCalls = calls.filter((c) => c.url.includes("resend.com"));
    assert.strictEqual(resendCalls.length, 0, "no Resend calls should fire without RESEND_API_KEY");
    console.log("PASS: submission-created returns 200 with RESEND_API_KEY unset, sends no email");
  });

  // 2) submission-created WITH RESEND_API_KEY: 200, and two well-formed Resend calls.
  process.env.RESEND_API_KEY = "fake-key";
  process.env.NOTIFY_EMAIL = "jamalknyc@gmail.com";
  await withFetch(async () => {
    const mod = freshHandler("../netlify/functions/submission-created.js");
    const res = await mod.handler({
      body: JSON.stringify({
        payload: {
          form_name: "event-submit",
          data: {
            event: "Beach Yoga",
            date: "2026-10-04",
            category: "Run & Fitness,Surf & Beach",
            free: "on",
            url: "example.com/yoga",
            email: "submitter@example.com",
            name: "Sasha",
          },
        },
      }),
    });
    assert.strictEqual(res.statusCode, 200, "submission-created (with key) should be 200");

    const emailCalls = calls.filter((c) => c.url.includes("api.resend.com/emails"));
    assert.strictEqual(emailCalls.length, 2, "expected notify + confirmation emails");

    const notify = emailCalls.find((c) => c.body.to.includes("jamalknyc@gmail.com"));
    assert.ok(notify, "notify email should go to NOTIFY_EMAIL");
    assert.ok(notify.body.from, "notify email needs a from");
    assert.ok(notify.body.subject.includes("Beach Yoga"), "subject should include event title");
    assert.ok(notify.body.html.includes("Beach Yoga"), "html body should include event title");

    const confirm = emailCalls.find((c) => c.body.to.includes("submitter@example.com"));
    assert.ok(confirm, "confirmation email should go to the submitter");
    assert.strictEqual(confirm.body.reply_to, "hello@rockawayevents.org");
    assert.ok(confirm.body.html.includes("Beach Yoga"));

    console.log("PASS: submission-created sends well-formed notify + confirmation emails");
  });

  // 3) moderate approve: sends the approval email using the PATCH response.
  await withFetch(async () => {
    process.env.MODERATE_KEY = "k";
    const mod = freshHandler("../netlify/functions/moderate.js");
    const res = await mod.handler({
      httpMethod: "POST",
      body: JSON.stringify({ id: "page-123", action: "approve", key: "k" }),
    });
    assert.strictEqual(res.statusCode, 200, "moderate approve should be 200");
    const emailCalls = calls.filter((c) => c.url.includes("api.resend.com/emails"));
    assert.strictEqual(emailCalls.length, 1, "expected one approval email");
    assert.strictEqual(emailCalls[0].body.to[0], "submitter@example.com");
    assert.ok(emailCalls[0].body.html.includes("rockawayevents.org/#e=page-123"));
    console.log("PASS: moderate approve emails the submitter with the event link");
  });

  // 4) moderate reject: no email at all.
  await withFetch(async () => {
    const mod = freshHandler("../netlify/functions/moderate.js");
    const res = await mod.handler({
      httpMethod: "POST",
      body: JSON.stringify({ id: "page-123", action: "reject", key: "k" }),
    });
    assert.strictEqual(res.statusCode, 200, "moderate reject should be 200");
    const emailCalls = calls.filter((c) => c.url.includes("api.resend.com/emails"));
    assert.strictEqual(emailCalls.length, 0, "reject should never send email");
    console.log("PASS: moderate reject sends no email");
  });

  // 5) subscribe: valid email calls addContact with a well-formed body.
  process.env.RESEND_AUDIENCE_ID = "aud-1";
  await withFetch(async () => {
    const mod = freshHandler("../netlify/functions/subscribe.js");
    const res = await mod.handler({
      httpMethod: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Fan@Example.com", name: "Fan" }),
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).ok, true);
    const contactCalls = calls.filter((c) => c.url.includes("audiences"));
    assert.strictEqual(contactCalls.length, 1);
    assert.strictEqual(contactCalls[0].body.email, "fan@example.com");
    assert.strictEqual(contactCalls[0].body.unsubscribed, false);
    console.log("PASS: subscribe adds a well-formed contact");
  });

  // 6) subscribe: invalid email is rejected before ever calling Resend.
  await withFetch(async () => {
    const mod = freshHandler("../netlify/functions/subscribe.js");
    const res = await mod.handler({
      httpMethod: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(calls.length, 0, "invalid email should never reach Resend");
    console.log("PASS: subscribe rejects an invalid email without calling Resend");
  });

  // 7) subscribe: honeypot filled -> silent 200, no Resend call.
  await withFetch(async () => {
    const mod = freshHandler("../netlify/functions/subscribe.js");
    const res = await mod.handler({
      httpMethod: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bot@example.com", website: "http://spam.example" }),
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls.length, 0, "honeypot should never reach Resend");
    console.log("PASS: subscribe honeypot short-circuits silently");
  });

  console.log("\nAll email tests passed.");
}

run().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
