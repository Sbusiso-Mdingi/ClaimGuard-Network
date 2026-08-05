function governanceResponse(c, code, message, status = 409) {
  return c.json({
    available: false,
    code,
    message,
    correlationId: c.get("requestId") || "unavailable",
  }, status);
}

async function blockLegacyStatusMutation(c, next) {
  const payload = await c.req.raw.clone().json().catch(() => null);
  if (payload && Object.hasOwn(payload, "status")) {
    return governanceResponse(
      c,
      "LEGACY_INVESTIGATION_STATUS_WRITE_DISABLED",
      "Investigation lifecycle changes must use the governed Sequrin case-action API.",
    );
  }
  await next();
}

export function registerLegacyCaseWriteGuards(app) {
  app.patch("/investigations/:id", blockLegacyStatusMutation);
  app.patch("/desktop/investigations/:id", blockLegacyStatusMutation);

  app.post("/investigations/confirm-fraud", (c) => governanceResponse(
    c,
    "NETWORK_NOTICE_GOVERNANCE_REQUIRED",
    "The legacy fraud-confirmation command is disabled. Complete an investigation report and use independent outcome review through the governed case workflow.",
  ));
}
