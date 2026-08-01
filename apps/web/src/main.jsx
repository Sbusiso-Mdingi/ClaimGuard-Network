import React from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./AppRoot";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "./lib/sentryScrub";
import "./styles.css";
import "./workspace-polish.css";

if (window.__CLAIMGUARD_WEB_SENTRY_READY__ !== true) {
  window.__CLAIMGUARD_WEB_SENTRY_READY__ = true;

  if (window.__CLAIMGUARD_WEB_DSN__) {
    Sentry.init({
      dsn: window.__CLAIMGUARD_WEB_DSN__,
      environment: window.__CLAIMGUARD_WEB_ENV__ || "development",
      release: window.__CLAIMGUARD_WEB_RELEASE__ || undefined,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      beforeSend: scrubSentryEvent,
      beforeBreadcrumb: scrubSentryBreadcrumb,
    });
  }
}

const el = document.getElementById("app");
if (el) {
  const root = createRoot(el);
  root.render(<App />);
}
