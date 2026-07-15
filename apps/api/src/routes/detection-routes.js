export function registerDetectionRoutes(app, { reportService }) {
  app.get("/detection/report", async (c) => {
    const result = await reportService.getDetectionReport();
    return c.json(result.body, result.status);
  });

  app.get("/detection/graph", async (c) => {
    const result = await reportService.getDetectionGraph();
    return c.json(result.body, result.status);
  });

  app.get("/detection/risk", async (c) => {
    const result = await reportService.getDetectionRisk();
    return c.json(result.body, result.status);
  });

  app.post("/detection/analyze", async (c) => {
    const payload = await c.req.json().catch(() => null);
    if (!payload || !Array.isArray(payload.claims)) {
      return c.json(
        {
          available: false,
          message: "Request body must include a claims array.",
        },
        400,
      );
    }

    const result = await reportService.analyze(payload);
    return c.json(result.body, result.status);
  });
}
