import { expect, test } from "vitest";
import { injectRuntimeConfiguration } from "../runtime-configuration.js";

test("injects Clerk values without replacing the runtime property names", async () => {
  const indexHtml = [
    'window.__CLERK_PUBLISHABLE_KEY__ = "__RUNTIME_CLERK_PUBLISHABLE_KEY__";',
    'window.__CLERK_PROXY_URL__ = "__RUNTIME_CLERK_PROXY_URL__";',
  ].join("\n");
  const rendered = injectRuntimeConfiguration(indexHtml, {
    clerkProxyUrl: "https://work.sequrin.example/__clerk",
    env: { CLERK_PUBLISHABLE_KEY: "pk_live_runtime_example" },
  });

  expect(rendered).toContain(
    'window.__CLERK_PUBLISHABLE_KEY__ = "pk_live_runtime_example";',
  );
  expect(rendered).toContain(
    'window.__CLERK_PROXY_URL__ = "https://work.sequrin.example/__clerk";',
  );
  expect(rendered).not.toContain("window.pk_live_runtime_example");
  expect(rendered).not.toContain("window.https://");
});
