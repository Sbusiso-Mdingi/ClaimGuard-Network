import assert from "node:assert/strict";
import {
  afterEach,
  test,
} from "node:test";

import { Hono } from "hono";

import {
  CLAIMGUARD_PERMISSIONS,
} from "../src/authorization-policy.js";
import {
  registerAdminRoutes,
} from "../src/routes/admin-routes.js";


const TENANT_CONTEXT = Object.freeze({
  tenant_id: "tenant-alpha",
  tenant_slug: "alpha",
  scheme_id: "ALPHA01",
});

const AUTHENTICATED_ADMIN = Object.freeze({
  is_authenticated: true,
  user_id: "scheme-admin-1",
  tenant_id: "tenant-alpha",
  roles: Object.freeze([
    "scheme_administrator",
  ]),
  permissions: new Set([
    CLAIMGUARD_PERMISSIONS.USERS_MANAGE_TENANT,
  ]),
});

const AUTHENTICATED_NON_ADMIN =
  Object.freeze({
    is_authenticated: true,
    user_id: "fraud-analyst-1",
    tenant_id: "tenant-alpha",
    roles: Object.freeze([
      "fraud_analyst",
    ]),
    permissions: new Set(),
  });

const UNAUTHENTICATED =
  Object.freeze({
    is_authenticated: false,
    user_id: null,
    tenant_id: null,
    roles: Object.freeze([]),
    permissions: new Set(),
  });

const APPROVED_DEPLOYMENT_ID =
  "claimguard-claim-fraud-ensemble:1.1.0";


function createReportService() {
  return {
    async checkReadiness() {
      return {
        ready: true,
        degraded: false,
        checks: {},
      };
    },
  };
}


function createApp({
  repository = null,
  authContext = AUTHENTICATED_ADMIN,
  tenantContext = TENANT_CONTEXT,
} = {}) {
  const app = new Hono();

  app.use(
    "*",
    async (context, next) => {
      context.set(
        "authContext",
        authContext,
      );

      context.set(
        "tenantContext",
        tenantContext,
      );

      await next();
    },
  );

  registerAdminRoutes(
    app,
    {
      reportService:
        createReportService(),

      detectionStrategyRepository:
        repository,
    },
  );

  return app;
}


async function responseJson(
  response,
) {
  return response.json();
}


afterEach(
  () => {
    delete process.env
      .APPROVED_MODEL_DEPLOYMENT_IDS;
  },
);


test(
  "GET /detection/strategy returns the active tenant strategy",
  async () => {
    const calls = [];

    const repository = {
      async getActiveStrategy(
        tenantContext,
      ) {
        calls.push(
          tenantContext,
        );

        return {
          tenantId:
            "tenant-alpha",

          strategyType:
            "deterministic_rules",

          modelDeploymentId:
            null,

          isActive:
            1,
        };
      },
    };

    const app = createApp({
      repository,
    });

    const response =
      await app.request(
        "/detection/strategy",
      );

    assert.equal(
      response.status,
      200,
    );

    assert.deepEqual(
      await responseJson(
        response,
      ),
      {
        available: true,

        strategy: {
          tenantId:
            "tenant-alpha",

          strategyType:
            "deterministic_rules",

          modelDeploymentId:
            null,

          isActive:
            1,
        },
      },
    );

    assert.deepEqual(
      calls,
      [
        TENANT_CONTEXT,
      ],
    );
  },
);


test(
  "PUT /detection/strategy activates an approved model with actor and reason",
  async () => {
    process.env
      .APPROVED_MODEL_DEPLOYMENT_IDS =
        APPROVED_DEPLOYMENT_ID;

    const calls = [];

    const repository = {
      async setStrategy(
        tenantContext,
        change,
      ) {
        calls.push({
          tenantContext,
          change,
        });

        return {
          tenantId:
            "tenant-alpha",

          strategyType:
            change.strategyType,

          modelDeploymentId:
            change.modelDeploymentId,
        };
      },
    };

    const app = createApp({
      repository,
    });

    const response =
      await app.request(
        "/detection/strategy",
        {
          method: "PUT",

          headers: {
            "content-type":
              "application/json",
          },

          body: JSON.stringify({
            strategyType:
              "approved_model",

            modelDeploymentId:
              APPROVED_DEPLOYMENT_ID,

            changeReason:
              "Activate the approved model after validation.",
          }),
        },
      );

    assert.equal(
      response.status,
      200,
    );

    assert.deepEqual(
      calls,
      [
        {
          tenantContext:
            TENANT_CONTEXT,

          change: {
            strategyType:
              "approved_model",

            modelDeploymentId:
              APPROVED_DEPLOYMENT_ID,

            actor:
              "scheme-admin-1",

            changeReason:
              "Activate the approved model after validation.",
          },
        },
      ],
    );

    assert.deepEqual(
      await responseJson(
        response,
      ),
      {
        available: true,

        strategy: {
          tenantId:
            "tenant-alpha",

          strategyType:
            "approved_model",

          modelDeploymentId:
            APPROVED_DEPLOYMENT_ID,
        },
      },
    );
  },
);


test(
  "PUT /detection/strategy clears model deployment for deterministic rules",
  async () => {
    const calls = [];

    const repository = {
      async setStrategy(
        tenantContext,
        change,
      ) {
        calls.push({
          tenantContext,
          change,
        });

        return {
          tenantId:
            "tenant-alpha",

          strategyType:
            "deterministic_rules",

          modelDeploymentId:
            null,
        };
      },
    };

    const app = createApp({
      repository,
    });

    const response =
      await app.request(
        "/detection/strategy",
        {
          method: "PUT",

          headers: {
            "content-type":
              "application/json",
          },

          body: JSON.stringify({
            strategyType:
              "deterministic_rules",

            modelDeploymentId:
              null,

            changeReason:
              "Return to deterministic rules during maintenance.",
          }),
        },
      );

    assert.equal(
      response.status,
      200,
    );

    assert.equal(
      calls.length,
      1,
    );

    assert.deepEqual(
      calls[0].change,
      {
        strategyType:
          "deterministic_rules",

        modelDeploymentId:
          null,

        actor:
          "scheme-admin-1",

        changeReason:
          "Return to deterministic rules during maintenance.",
      },
    );
  },
);


test(
  "PUT /detection/strategy rejects a missing audit reason",
  async () => {
    let repositoryCalled = false;

    const repository = {
      async setStrategy() {
        repositoryCalled = true;

        throw new Error(
          "Repository must not be called.",
        );
      },
    };

    const app = createApp({
      repository,
    });

    const response =
      await app.request(
        "/detection/strategy",
        {
          method: "PUT",

          headers: {
            "content-type":
              "application/json",
          },

          body: JSON.stringify({
            strategyType:
              "deterministic_rules",

            modelDeploymentId:
              null,
          }),
        },
      );

    assert.equal(
      response.status,
      400,
    );

    assert.deepEqual(
      await responseJson(
        response,
      ),
      {
        available: false,

        message:
          "changeReason must contain 1–500 characters.",
      },
    );

    assert.equal(
      repositoryCalled,
      false,
    );
  },
);


test(
  "PUT /detection/strategy rejects unsupported payload fields",
  async () => {
    let repositoryCalled = false;

    const repository = {
      async setStrategy() {
        repositoryCalled = true;
      },
    };

    const app = createApp({
      repository,
    });

    const response =
      await app.request(
        "/detection/strategy",
        {
          method: "PUT",

          headers: {
            "content-type":
              "application/json",
          },

          body: JSON.stringify({
            strategyType:
              "deterministic_rules",

            modelDeploymentId:
              null,

            changeReason:
              "Use deterministic rules.",

            actor:
              "forged-user",
          }),
        },
      );

    assert.equal(
      response.status,
      400,
    );

    assert.deepEqual(
      await responseJson(
        response,
      ),
      {
        available: false,

        message:
          "The strategy payload contains unsupported fields.",
      },
    );

    assert.equal(
      repositoryCalled,
      false,
    );
  },
);


test(
  "PUT /detection/strategy rejects an unapproved model deployment",
  async () => {
    process.env
      .APPROVED_MODEL_DEPLOYMENT_IDS =
        APPROVED_DEPLOYMENT_ID;

    let repositoryCalled = false;

    const repository = {
      async setStrategy() {
        repositoryCalled = true;
      },
    };

    const app = createApp({
      repository,
    });

    const response =
      await app.request(
        "/detection/strategy",
        {
          method: "PUT",

          headers: {
            "content-type":
              "application/json",
          },

          body: JSON.stringify({
            strategyType:
              "approved_model",

            modelDeploymentId:
              "unapproved-model:9.9.9",

            changeReason:
              "Attempt an unapproved deployment.",
          }),
        },
      );

    assert.equal(
      response.status,
      400,
    );

    assert.deepEqual(
      await responseJson(
        response,
      ),
      {
        available: false,

        message:
          "modelDeploymentId is not approved in this environment.",
      },
    );

    assert.equal(
      repositoryCalled,
      false,
    );
  },
);


test(
  "PUT /detection/strategy rejects a deployment for deterministic rules",
  async () => {
    let repositoryCalled = false;

    const repository = {
      async setStrategy() {
        repositoryCalled = true;
      },
    };

    const app = createApp({
      repository,
    });

    const response =
      await app.request(
        "/detection/strategy",
        {
          method: "PUT",

          headers: {
            "content-type":
              "application/json",
          },

          body: JSON.stringify({
            strategyType:
              "deterministic_rules",

            modelDeploymentId:
              APPROVED_DEPLOYMENT_ID,

            changeReason:
              "Invalid mixed configuration.",
          }),
        },
      );

    assert.equal(
      response.status,
      400,
    );

    assert.deepEqual(
      await responseJson(
        response,
      ),
      {
        available: false,

        message:
          "Deterministic strategy cannot select a model deployment.",
      },
    );

    assert.equal(
      repositoryCalled,
      false,
    );
  },
);


test(
  "strategy routes reject unauthenticated callers",
  async () => {
    let repositoryCalled = false;

    const repository = {
      async getActiveStrategy() {
        repositoryCalled = true;
      },

      async setStrategy() {
        repositoryCalled = true;
      },
    };

    const app = createApp({
      repository,
      authContext:
        UNAUTHENTICATED,
    });

    const getResponse =
      await app.request(
        "/detection/strategy",
      );

    assert.equal(
      getResponse.status,
      401,
    );

    const putResponse =
      await app.request(
        "/detection/strategy",
        {
          method: "PUT",

          headers: {
            "content-type":
              "application/json",
          },

          body: JSON.stringify({
            strategyType:
              "deterministic_rules",

            modelDeploymentId:
              null,

            changeReason:
              "This request must not be accepted.",
          }),
        },
      );

    assert.equal(
      putResponse.status,
      401,
    );

    assert.equal(
      repositoryCalled,
      false,
    );
  },
);


test(
  "strategy routes reject authenticated users without tenant-management permission",
  async () => {
    let repositoryCalled = false;

    const repository = {
      async getActiveStrategy() {
        repositoryCalled = true;
      },

      async setStrategy() {
        repositoryCalled = true;
      },
    };

    const app = createApp({
      repository,
      authContext:
        AUTHENTICATED_NON_ADMIN,
    });

    const getResponse =
      await app.request(
        "/detection/strategy",
      );

    assert.equal(
      getResponse.status,
      403,
    );

    const putResponse =
      await app.request(
        "/detection/strategy",
        {
          method: "PUT",

          headers: {
            "content-type":
              "application/json",
          },

          body: JSON.stringify({
            strategyType:
              "deterministic_rules",

            modelDeploymentId:
              null,

            changeReason:
              "This request must not be accepted.",
          }),
        },
      );

    assert.equal(
      putResponse.status,
      403,
    );

    assert.equal(
      repositoryCalled,
      false,
    );
  },
);


test(
  "strategy routes fail closed when the repository is unavailable",
  async () => {
    const app = createApp({
      repository: null,
    });

    const getResponse =
      await app.request(
        "/detection/strategy",
      );

    assert.equal(
      getResponse.status,
      503,
    );

    assert.deepEqual(
      await responseJson(
        getResponse,
      ),
      {
        available: false,

        message:
          "Detection strategy repository not available",
      },
    );

    const putResponse =
      await app.request(
        "/detection/strategy",
        {
          method: "PUT",

          headers: {
            "content-type":
              "application/json",
          },

          body: JSON.stringify({
            strategyType:
              "deterministic_rules",

            modelDeploymentId:
              null,

            changeReason:
              "Repository unavailable test.",
          }),
        },
      );

    assert.equal(
      putResponse.status,
      503,
    );
  },
);
