import assert from "node:assert/strict";
import test from "node:test";

import {
  createPrivateDatabaseAdapter,
} from "../src/private-database-adapter.js";


function baseContext(
  overrides = {},
) {
  return {
    organisationId:
      "org-private",

    organisationType:
      "medical_scheme",

    organisationStatus:
      "active",

    routeId:
      "route-private",

    routeType:
      "private_database",

    routeGeneration:
      1,

    logicalDatabaseIdentifier:
      "private-db-1",

    schemaVersion:
      "14",

    deploymentClass:
      "production",

    secretReference:
      "https://kv.example.vault.azure.net/secrets/user",

    ...overrides,
  };
}


test(
  "private adapter rejects non-private route type",
  async () => {
    const adapter =
      createPrivateDatabaseAdapter();

    await assert.rejects(
      adapter.create(
        baseContext({
          routeType:
            "legacy_shared",

          operationalTenantId:
            "tenant-shared",

          operationalTenantSlug:
            "tenant-shared",
        }),
      ),
      /private_database routes/,
    );
  },
);


test(
  "private adapter rejects incomplete secret references before pool creation",
  async () => {
    let poolFactoryCalled =
      false;

    const adapter =
      createPrivateDatabaseAdapter({
        poolFactory() {
          poolFactoryCalled =
            true;

          return {};
        },
      });

    await assert.rejects(
      adapter.create(
        baseContext({
          secretReference:
            "https://kv.example.vault.azure.net/secrets/user",
        }),
      ),
      /must include exactly username, password, host, and database secret URLs/,
    );

    assert.equal(
      poolFactoryCalled,
      false,
    );
  },
);


test(
  "private adapter verify enforces metadata compatibility",
  async () => {
    const adapter =
      createPrivateDatabaseAdapter({
        supportedSchemaVersions: [
          "14",
        ],

        expectedEnvironment:
          "production",
      });

    const pool = {
      async execute() {
        return [
          [
            {
              database_mode:
                "private_database",

              logical_database_identifier:
                "private-db-1",

              schema_version:
                "14",

              environment_key:
                "staging",

              migration_version:
                14,
            },
          ],
          [],
        ];
      },
    };

    await assert.rejects(
      adapter.verify(
        pool,
        baseContext(),
      ),
      /Private environment verification failed/,
    );
  },
);


test(
  "private adapter verify rejects an unsupported schema before publication",
  async () => {
    const adapter =
      createPrivateDatabaseAdapter({
        supportedSchemaVersions: [
          "14",
        ],
      });

    const pool = {
      async execute() {
        return [
          [
            {
              database_mode:
                "private_database",

              logical_database_identifier:
                "private-db-1",

              schema_version:
                "13",

              environment_key:
                "production",

              migration_version:
                13,
            },
          ],
          [],
        ];
      },
    };

    await assert.rejects(
      adapter.verify(
        pool,
        baseContext(),
      ),
      /Private schema version is unsupported/,
    );
  },
);


test(
  "private adapter verify rejects metadata that differs from the active route",
  async () => {
    const adapter =
      createPrivateDatabaseAdapter();

    const pool = {
      async execute() {
        return [
          [
            {
              database_mode:
                "private_database",

              logical_database_identifier:
                "private-db-1",

              schema_version:
                "14",

              environment_key:
                "production",

              migration_version:
                14,
            },
          ],
          [],
        ];
      },
    };

    await assert.rejects(
      adapter.verify(
        pool,
        baseContext({
          schemaVersion:
            "15",
        }),
      ),
      /does not match active route/,
    );
  },
);


test(
  "private adapter verify rejects a migration version that differs from its schema",
  async () => {
    const adapter =
      createPrivateDatabaseAdapter();

    const pool = {
      async execute() {
        return [
          [
            {
              database_mode:
                "private_database",

              logical_database_identifier:
                "private-db-1",

              schema_version:
                "14",

              environment_key:
                "production",

              migration_version:
                13,
            },
          ],
          [],
        ];
      },
    };

    await assert.rejects(
      adapter.verify(
        pool,
        baseContext(),
      ),
      /Private migration version verification failed/,
    );
  },
);


test(
  "private adapter verify returns normalized metadata when compatible",
  async () => {
    const adapter =
      createPrivateDatabaseAdapter({
        supportedSchemaVersions: [
          "14",
        ],

        expectedEnvironment:
          "production",
      });

    const pool = {
      async execute() {
        return [
          [
            {
              database_mode:
                "private_database",

              logical_database_identifier:
                "private-db-1",

              schema_version:
                "14",

              environment_key:
                "production",

              migration_version:
                14,
            },
          ],
          [],
        ];
      },
    };

    const verified =
      await adapter.verify(
        pool,
        baseContext(),
      );

    assert.deepEqual(
      verified,
      {
        routeType:
          "private_database",

        logicalDatabaseIdentifier:
          "private-db-1",

        schemaVersion:
          "14",

        migrationVersion:
          14,
      },
    );

    assert.equal(
      Object.isFrozen(
        verified,
      ),
      true,
    );
  },
);
