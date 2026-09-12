// netlify/functions/enrich-images-run.js
// Manual HTTP trigger for the image enricher. Netlify refuses direct HTTP calls
// to a *scheduled* function (403), so /api/enrich-images points here instead;
// this simply delegates to the scheduled module's handler, which still enforces
// the MODERATE_KEY check for non-scheduled invocations.
const { handler } = require("./enrich-images");
exports.handler = (event, context) => handler(event, context);
