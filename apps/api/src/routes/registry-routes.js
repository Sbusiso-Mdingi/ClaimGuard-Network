import { createRequireOperationalRouteAuthorizationMiddleware } from "../middleware/authorization-middleware.js";
import { OPERATIONAL_ROUTE_IDS } from "../authorization-policy.js";
import { registryErrorResponse, sharedRegistryUnavailable } from "./http-response-helpers.js";

export function registerRegistryRoutes(app, { registryService }) {
  const requireRegistrySearchPermission = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.REGISTRY_SEARCH,
  });
  const requireRegistryHistoryPermission = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.REGISTRY_HISTORY,
  });
  const requireRegistryDetailPermission = createRequireOperationalRouteAuthorizationMiddleware({
    routeId: OPERATIONAL_ROUTE_IDS.REGISTRY_DETAIL,
  });

  app.get(
    "/registry/search",
    requireRegistrySearchPermission,
    async (c) => {
      if (!registryService.hasMethod("searchRegistry")) {
        return sharedRegistryUnavailable(c);
      }

      const subjectToken = c.req.query("subjectToken");
      if (!subjectToken || !subjectToken.trim()) {
        return c.json(
          {
            available: false,
            message: "subjectToken query parameter is required.",
          },
          400,
        );
      }

      try {
        const fraudSubjectType = c.req.query("fraudSubjectType") || null;
        const results = await registryService.searchRegistry({
          subjectToken: subjectToken.trim(),
          fraudSubjectType,
        });

        return c.json({ available: true, results }, 200);
      } catch (error) {
        return registryErrorResponse(c, error);
      }
    },
  );

  app.get(
    "/registry/history/:subjectToken",
    requireRegistryHistoryPermission,
    async (c) => {
      if (!registryService.hasMethod("getRegistryHistory")) {
        return sharedRegistryUnavailable(c);
      }

      const subjectToken = c.req.param("subjectToken");
      if (!subjectToken || !subjectToken.trim()) {
        return c.json(
          {
            available: false,
            message: "subjectToken path parameter is required.",
          },
          400,
        );
      }

      try {
        const history = await registryService.getRegistryHistory(subjectToken.trim());
        return c.json({ available: true, history }, 200);
      } catch (error) {
        return registryErrorResponse(c, error);
      }
    },
  );

  app.get(
    "/registry/:id",
    requireRegistryDetailPermission,
    async (c) => {
      if (!registryService.hasMethod("getRegistryRecordById")) {
        return sharedRegistryUnavailable(c);
      }

      const registryEntryId = c.req.param("id");
      if (!registryEntryId || !registryEntryId.trim()) {
        return c.json(
          {
            available: false,
            message: "Registry entry ID is required.",
          },
          400,
        );
      }

      try {
        const record = await registryService.getRegistryRecordById(registryEntryId.trim());
        if (!record) {
          return c.json(
            {
              available: false,
              message: "The shared fraud registry record was not found.",
            },
            404,
          );
        }

        return c.json({ available: true, record }, 200);
      } catch (error) {
        return registryErrorResponse(c, error);
      }
    },
  );
}
