import assert from "node:assert/strict";
import test from "node:test";
import {
  readFile,
} from "node:fs/promises";

import {
  CANONICAL_OPERATIONAL_SCHEMA_VERSION,
  REQUIRED_STEPS,
  REQUIRED_UPGRADE_STEPS,
} from "../src/worker.js";


test(
  "required provisioning steps include phase 11E activation gate sequence",
  () => {
    assert.deepEqual(
      REQUIRED_STEPS,
      [
        "validate_request",
        "reserve_slug",
        "create_organisation_record",
        "allocate_database_name",
        "create_database",
        "create_database_principal",
        "store_secret_references",
        "apply_tenant_schema",
        "write_data_plane_metadata",
        "verify_database_isolation",
        "create_report_partition",
        "register_worker_routing",
        "register_private_route",
        "grant_report_worker_secret_access",
        "record_schema_compatibility",
        "mark_report_worker_ready",
        "create_initial_scheme_admin",
        "run_activation_checks",
        "ready_for_activation",
      ],
    );
  },
);


test(
  "private database upgrade has a resumable canonical schema and route-promotion sequence",
  () => {
    assert.deepEqual(
      REQUIRED_UPGRADE_STEPS,
      [
        "validate_upgrade_request",
        "apply_tenant_schema",
        "write_data_plane_metadata",
        "verify_database_isolation",
        "grant_report_worker_secret_access",
        "register_canonical_schema_route",
        "record_schema_compatibility",
        "mark_report_worker_ready",
      ],
    );
  },
);


test(
  "private databases use canonical operational migrations and private metadata",
  async () => {
    const worker =
      await readFile(
        new URL(
          "../src/worker.js",
          import.meta.url,
        ),
        "utf8",
      );

    assert.equal(
      CANONICAL_OPERATIONAL_SCHEMA_VERSION,
      "14",
    );

    assert.match(
      worker,
      /applyMigrations\(\s*connection/,
    );

    assert.match(
      worker,
      /database_mode = 'private_database'/,
    );

    assert.match(
      worker,
      /schema_version = \?/,
    );

    assert.match(
      worker,
      /migration_version = \?/,
    );

    assert.match(
      worker,
      /policy\.schemaVersion/,
    );

    assert.match(
      worker,
      /policy\.migrationVersion/,
    );

    assert.match(
      worker,
      /canonicalMigrationVersion\(schemaVersion\)/,
    );

    assert.match(
      worker,
      /CANONICAL_OPERATIONAL_SCHEMA_VERSION = "14"/,
    );

    assert.match(
      worker,
      /register_canonical_schema_route/,
    );

    assert.doesNotMatch(
      worker,
      /register_schema_13_route/,
    );

    assert.doesNotMatch(
      worker,
      /migration_version = 13/,
    );

    assert.doesNotMatch(
      worker,
      /simulator-worker/,
    );

    assert.match(
      worker,
      /cross-database access/,
    );

    assert.match(
      worker,
      /GRANT SELECT, INSERT, UPDATE, DELETE ON/,
    );

    assert.doesNotMatch(
      worker,
      /GRANT .*CREATE.*ALTER.* ON/i,
    );
  },
);


test(
  "Container Apps Job is manual, single-replica, identity-based, and contains no connection strings",
  async () => {
    const manifest =
      await readFile(
        new URL(
          "../aca-job.phase11e.yaml",
          import.meta.url,
        ),
        "utf8",
      );

    assert.match(
      manifest,
      /triggerType: Manual/,
    );

    assert.match(
      manifest,
      /parallelism: 1/,
    );

    assert.match(
      manifest,
      /replicaCompletionCount: 1/,
    );

    assert.match(
      manifest,
      /type: UserAssigned/,
    );

    assert.match(
      manifest,
      /secretRef: control-plane-mysql-url/,
    );

    assert.match(
      manifest,
      /secretRef: mysql-server-admin-url/,
    );

    assert.match(
      manifest,
      /keyVaultUrl:/,
    );

    assert.doesNotMatch(
      manifest,
      /mysql:\/\//,
    );

    assert.doesNotMatch(
      manifest,
      /<user>|<password>|phase11e-pending/,
    );

    assert.match(
      manifest,
      /AZURE_REPORT_WORKER_PRINCIPAL_ID/,
    );
  },
);
