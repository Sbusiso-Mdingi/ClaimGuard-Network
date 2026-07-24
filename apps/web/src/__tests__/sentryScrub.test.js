import { describe, expect, it } from "vitest";

import {
  redactSensitiveText,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from "../lib/sentryScrub";

const SECRET = "INVITE_TOKEN_MUST_NEVER_LEAK_123";

describe("Sentry invitation-token redaction", () => {
  it("redacts token-bearing URLs and bearer material", () => {
    const redacted = redactSensitiveText(
      `https://web.example/signup?token=${SECRET}&next=/home /auth/invitation/${SECRET} Bearer ${SECRET}`,
    );

    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).toContain("/auth/invitation/[REDACTED]");
    expect(redacted).toContain("Bearer [REDACTED]");
  });

  it("scrubs nested event and breadcrumb fields without removing safe context", () => {
    const event = scrubSentryEvent({
      request: {
        url: `https://web.example/signup?token=${SECRET}`,
        headers: {
          authorization: `Bearer ${SECRET}`,
          cookie: `session=${SECRET}`,
        },
        data: {
          token: SECRET,
          username: "ubuntu.admin",
        },
      },
    });

    const breadcrumb = scrubSentryBreadcrumb({
      category: "navigation",
      message: `from /signup?token=${SECRET} to /signup`,
    });

    const rendered = JSON.stringify({ event, breadcrumb });
    expect(rendered).not.toContain(SECRET);
    expect(rendered).toContain("ubuntu.admin");
    expect(rendered).toContain("[REDACTED]");
  });
});
