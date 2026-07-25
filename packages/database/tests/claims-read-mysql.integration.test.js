import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMigrations,
  createMysqlConnection,
} from "../src/index.js";

const databaseUrl = process.env.OPERATIONAL_TEST_MYSQL_URL || "";

test(
  "real MySQL extracts and filters claim-version targets from outbox JSON",
  { skip: !databaseUrl },
  async () => {
    const pool = createMysqlConnection(databaseUrl);

    try {
      await applyMigrations(pool, undefined, {
        applicationVersion: "claims-read-integration-test",
      });

      const payload = JSON.stringify({
        schema_version: 2,
        dataset_scope: "triggering_claim_versions",
        targets: [
          { claim_id: "CLAIM-A", claim_version: 1 },
          { claim_id: "CLAIM-B", claim_version: 3 },
        ],
      });

      const [rows] = await pool.execute(
        `
          SELECT
            targets.claim_id,
            targets.claim_version
          FROM JSON_TABLE(
            CAST(? AS JSON),
            '$.targets[*]' COLUMNS (
              claim_id VARCHAR(128) PATH '$.claim_id',
              claim_version INT PATH '$.claim_version'
            )
          ) AS targets
          WHERE (targets.claim_id, targets.claim_version) IN ((?, ?), (?, ?))
          ORDER BY targets.claim_id ASC, targets.claim_version ASC
        `,
        [payload, "CLAIM-B", 3, "CLAIM-MISSING", 9],
      );

      assert.deepEqual(
        rows.map((row) => ({
          claimId: row.claim_id,
          claimVersion: Number(row.claim_version),
        })),
        [{ claimId: "CLAIM-B", claimVersion: 3 }],
      );
    } finally {
      await pool.end();
    }
  },
);
