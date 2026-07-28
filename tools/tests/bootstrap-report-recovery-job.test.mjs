import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT_PATH = path.join(
  REPOSITORY_ROOT,
  "infra/bootstrap-report-recovery-job.sh",
);
const IDENTITY_ID =
  "/subscriptions/sub/resourceGroups/ClaimGuard/providers/"
  + "Microsoft.ManagedIdentity/userAssignedIdentities/"
  + "claimguard-report-worker-identity";
const BASE_ENV = Object.freeze({
  AZURE_RESOURCE_GROUP: "ClaimGuard",
  REPORT_WORKER_ENVIRONMENT_NAME: "claimguard-env-11e",
  REPORT_WORKER_IDENTITY_NAME: "claimguard-report-worker-identity",
  REPORT_WORKER_RECOVERY_JOB_NAME: "claimguard-report-recovery",
  REPORT_WORKER_RECOVERY_CRON: "0 0 1 1 *",
  REPORT_WORKER_ACR_NAME: "claimguardacr11e",
  MODEL_DEPLOYMENT_ID: "claimguard-claim-fraud-baseline:1.0.0",
  RECOVERY_EXECUTION_COUNT_BEFORE: "0",
  VALIDATED_MAIN_SHA: "4fbe50b2e97dc96a83dea968dfa368d70c84b5d1",
});

const FAKE_AZ = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_AZ_STATE;
const logPath = process.env.FAKE_AZ_LOG;
const identityId = process.env.FAKE_IDENTITY_ID;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const starts = (...prefix) => prefix.every((value, index) => args[index] === value);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const log = (value) => fs.appendFileSync(logPath, value + "\\n");

if (starts("identity", "show")) {
  process.stdout.write(identityId + "\\n");
} else if (starts("containerapp", "job", "show")) {
  if (!state.job) process.exit(3);
  process.stdout.write(JSON.stringify(state.job));
} else if (starts("containerapp", "job", "list")) {
  process.stdout.write(state.job ? "1\\n" : "0\\n");
} else if (starts("containerapp", "job", "execution", "list")) {
  process.stdout.write(String(state.executionCount) + "\\n");
} else if (starts("deployment", "group", "create")) {
  state.job = {
    identity: null,
    properties: {
      configuration: {
        triggerType: "Manual",
        scheduleTriggerConfig: null,
        manualTriggerConfig: {
          parallelism: 1,
          replicaCompletionCount: 1
        },
        replicaTimeout: 300,
        replicaRetryLimit: 0
      },
      template: {
        containers: [{
          name: "recovery-bootstrap",
          image: "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest",
          resources: {
            cpu: 0.25,
            memory: "0.5Gi"
          }
        }]
      }
    }
  };
  save();
  log("create-shell");
} else if (starts("containerapp", "job", "identity", "assign")) {
  state.job.identity = {
    type: "UserAssigned",
    userAssignedIdentities: {
      [identityId]: {}
    }
  };
  save();
  log("attach-identity");
} else {
  process.stderr.write("Unexpected fake az invocation: " + args.join(" ") + "\\n");
  process.exit(97);
}
`;

function manualJob({ image, identity = null } = {}) {
  return {
    identity,
    properties: {
      configuration: {
        triggerType: "Manual",
        scheduleTriggerConfig: null,
        manualTriggerConfig: {
          parallelism: 1,
          replicaCompletionCount: 1,
        },
        replicaTimeout: 300,
        replicaRetryLimit: 0,
      },
      template: {
        containers: [
          {
            name: "recovery-bootstrap",
            image:
              image
              || "mcr.microsoft.com/azuredocs/containerapps-helloworld:latest",
            resources: {
              cpu: 0.25,
              memory: "0.5Gi",
            },
          },
        ],
      },
    },
  };
}

function scheduledJob() {
  return {
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: {
        [IDENTITY_ID]: {},
      },
    },
    properties: {
      configuration: {
        triggerType: "Schedule",
        scheduleTriggerConfig: {
          cronExpression: "0 0 1 1 *",
        },
      },
      template: {
        containers: [
          {
            name: "report-producer-recovery",
            image:
              "claimguardacr11e.azurecr.io/claimguard/report-producer:"
              + "4fbe50b2e97dc96a83dea968dfa368d70c84b5d1",
            args: ["worker", "drain-all"],
            env: [
              {
                name: "MODEL_SERVICE_DEPLOYMENT_ID",
                value: "claimguard-claim-fraud-baseline:1.0.0",
              },
            ],
          },
        ],
      },
    },
  };
}

function runBootstrap(initialState) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "recovery-bootstrap-"));
  try {
    const azPath = path.join(directory, "az");
    const statePath = path.join(directory, "state.json");
    const logPath = path.join(directory, "operations.log");
    writeFileSync(azPath, FAKE_AZ);
    chmodSync(azPath, 0o755);
    writeFileSync(statePath, JSON.stringify(initialState));
    writeFileSync(logPath, "");

    const result = spawnSync("bash", [SCRIPT_PATH], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ...BASE_ENV,
        PATH: `${directory}:${process.env.PATH}`,
        FAKE_AZ_STATE: statePath,
        FAKE_AZ_LOG: logPath,
        FAKE_IDENTITY_ID: IDENTITY_ID,
      },
    });
    return {
      result,
      state: JSON.parse(readFileSync(statePath, "utf8")),
      operations: readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("absent recovery creates an identity-free shell before attaching identity", () => {
  const { result, state, operations } = runBootstrap({
    job: null,
    executionCount: 0,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(operations, ["create-shell", "attach-identity"]);
  assert.equal(state.job.properties.configuration.triggerType, "Manual");
  assert.deepEqual(
    Object.keys(state.job.identity.userAssignedIdentities),
    [IDENTITY_ID],
  );
});

test("exact scheduled recovery is accepted without mutation", () => {
  const { result, operations } = runBootstrap({
    job: scheduledJob(),
    executionCount: 0,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(operations, []);
});

test("unexpected manual bootstrap fails before identity attachment", () => {
  const { result, operations } = runBootstrap({
    job: manualJob({ image: "example.invalid/unexpected:latest" }),
    executionCount: 0,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manual bootstrap image is unexpected/);
  assert.deepEqual(operations, []);
});

test("manual bootstrap with an unexpected identity set fails closed", () => {
  const { result, operations } = runBootstrap({
    job: manualJob({
      identity: {
        type: "UserAssigned",
        userAssignedIdentities: {
          [IDENTITY_ID]: {},
          [`${IDENTITY_ID}-unexpected`]: {},
        },
      },
    }),
    executionCount: 0,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected user-assigned identity set/);
  assert.deepEqual(operations, []);
});

test("scheduled recovery with a non-parked cron fails closed", () => {
  const job = scheduledJob();
  job.properties.configuration.scheduleTriggerConfig.cronExpression =
    "0 * * * *";
  const { result, operations } = runBootstrap({
    job,
    executionCount: 0,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schedule is not parked/);
  assert.deepEqual(operations, []);
});
