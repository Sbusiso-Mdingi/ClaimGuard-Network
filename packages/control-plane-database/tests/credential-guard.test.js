import assert from "node:assert/strict";
import test from "node:test";

import {
  createSignupCredentialGuardedIdentityRepository,
} from "../src/index.js";

function transactionExecutor(rows = []) {
  const calls = [];

  return {
    calls,
    executor: {
      async execute(sql, parameters) {
        calls.push({
          sql: String(sql).replace(/\s+/g, " ").trim(),
          parameters,
        });

        return [rows, []];
      },
    },
  };
}

test("invitation credential guard rejects a second local-password credential", async () => {
  let createCredentialCalled = false;

  const identity = {
    async getInternalCredentialByUsername() {
      return null;
    },

    async createCredential() {
      createCredentialCalled = true;
      throw new Error("The underlying createCredential must not be called.");
    },
  };

  const guarded =
    createSignupCredentialGuardedIdentityRepository(identity);

  const { executor, calls } =
    transactionExecutor([
      {
        credential_id: "credential-existing",
      },
    ]);

  await assert.rejects(
    () =>
      guarded.createCredential(
        {
          userId: "user-existing",
          organisationId: "org-ubuntu",
          username: "different.username",
          status: "active",
          passwordHash: "$argon2id$test",
          passwordAlgorithm: "argon2id",
        },
        {
          executor,
        },
      ),
    (error) => {
      assert.equal(
        error.code,
        "ADMIN_CREDENTIAL_ALREADY_CONFIGURED",
      );

      assert.equal(
        error.status,
        409,
      );

      return true;
    },
  );

  assert.equal(createCredentialCalled, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].parameters,
    [
      "user-existing",
      "org-ubuntu",
    ],
  );
  assert.match(
    calls[0].sql,
    /authentication_provider = 'local_password'/,
  );
  assert.match(calls[0].sql, /FOR UPDATE$/);
});

test("invitation credential guard delegates when no local credential exists", async () => {
  let delegatedInput = null;
  let delegatedOptions = null;

  const identity = {
    async getInternalCredentialByUsername() {
      return null;
    },

    async createCredential(input, options) {
      delegatedInput = input;
      delegatedOptions = options;

      return {
        credentialId: "credential-new",
        userId: input.userId,
        organisationId: input.organisationId,
        normalizedUsername: input.username,
        status: input.status,
      };
    },
  };

  const guarded =
    createSignupCredentialGuardedIdentityRepository(identity);

  const { executor, calls } =
    transactionExecutor([]);

  const input = {
    userId: "user-existing",
    organisationId: "org-ubuntu",
    username: "ubuntu.admin",
    status: "active",
    passwordHash: "$argon2id$test",
    passwordAlgorithm: "argon2id",
  };

  const result =
    await guarded.createCredential(
      input,
      {
        executor,
      },
    );

  assert.equal(result.credentialId, "credential-new");
  assert.equal(delegatedInput, input);
  assert.equal(delegatedOptions.executor, executor);
  assert.equal(calls.length, 1);
});

test("partial repository doubles remain compatible with the control-plane service tests", () => {
  const identity = {
    async createCredential() {
      return {
        credentialId: "credential-test",
      };
    },
  };

  assert.equal(
    createSignupCredentialGuardedIdentityRepository(identity),
    identity,
  );
});
