import * as Sentry from "@sentry/node";

import { scrubSentryEvent } from "../sentry-scrub.js";

if (typeof Sentry.addEventProcessor === "function") {
  Sentry.addEventProcessor(scrubSentryEvent);
}

export function logEvent(level, event, details = {}) {
  const payload = scrubSentryEvent({
    timestamp: new Date().toISOString(),
    level,
    service: "api",
    event,
    ...details,
  });

  const rendered = JSON.stringify(payload);
  if (level === "error") {
    console.error(rendered);
  } else {
    console.log(rendered);
  }
}
