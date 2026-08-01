import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createDesktopDeviceProofVerifier, EMPTY_BODY_DIGEST } from "../src/desktop-device-proof.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

function pair() {
  const value = crypto.generateKeyPairSync("ed25519");
  return { privateKey: value.privateKey, publicJwk: value.publicKey.export({ format: "jwk" }) };
}

function proof(privateKey, { jti = crypto.randomUUID(), iat = 1785542400, path = "/desktop/sync/bootstrap" } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "dpop+jwt", kid: DEVICE_ID })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    deviceEnrollmentId: DEVICE_ID,
    htm: "GET",
    htu: `https://api.claimguard.example${path}`,
    body_sha256: EMPTY_BODY_DIGEST,
    iat,
    jti,
  })).toString("base64url");
  const signature = crypto.sign(null, Buffer.from(`${header}.${payload}`, "ascii"), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function fixture({ status = "active", expiresAt = "2026-08-02T00:00:00.000Z" } = {}) {
  const deviceKey = pair();
  const consumed = new Set();
  const repository = {
    async getDeviceById(id) {
      if (id !== DEVICE_ID) return null;
      return {
        deviceEnrollmentId: DEVICE_ID,
        organisationId: "org-alpha",
        permittedApiOrigin: "https://api.claimguard.example",
        devicePublicKey: deviceKey.publicJwk,
        status,
        expiresAt,
        revokedAt: status === "revoked" ? "2026-08-01T00:00:00.000Z" : null,
      };
    },
    async consumeProofNonce({ nonceHash }) {
      if (consumed.has(nonceHash)) return false;
      consumed.add(nonceHash);
      return true;
    },
    async touchDevice() {},
  };
  return {
    deviceKey,
    verifier: createDesktopDeviceProofVerifier({
      desktopEnrollmentRepository: repository,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    }),
  };
}

test("valid device proof succeeds once and replay is rejected", async () => {
  const value = fixture();
  const token = proof(value.deviceKey.privateKey, { jti: "unique-device-proof-0001" });
  const request = new Request("https://internal/desktop/sync/bootstrap", { headers: { dpop: token } });
  const device = await value.verifier.verify(request);
  assert.equal(device.deviceEnrollmentId, DEVICE_ID);
  await assert.rejects(() => value.verifier.verify(request), (error) => error.code === "DEVICE_PROOF_REPLAYED");
});

test("a copied enrollment cannot authenticate with a different private key", async () => {
  const value = fixture();
  const attacker = pair();
  const request = new Request("https://internal/desktop/sync/bootstrap", {
    headers: { dpop: proof(attacker.privateKey) },
  });
  await assert.rejects(() => value.verifier.verify(request), (error) => error.code === "DEVICE_PROOF_REJECTED");
});

test("revoked and expired devices are rejected before route access", async () => {
  const revoked = fixture({ status: "revoked" });
  await assert.rejects(
    () => revoked.verifier.verify(new Request("https://internal/desktop/sync/bootstrap", { headers: { dpop: proof(revoked.deviceKey.privateKey) } })),
    (error) => error.code === "DEVICE_ENROLLMENT_INACTIVE",
  );
  const expired = fixture({ expiresAt: "2026-07-31T00:00:00.000Z" });
  await assert.rejects(
    () => expired.verifier.verify(new Request("https://internal/desktop/sync/bootstrap", { headers: { dpop: proof(expired.deviceKey.privateKey) } })),
    (error) => error.code === "DEVICE_ENROLLMENT_INACTIVE",
  );
});
