import crypto from "node:crypto";

const ACTIVATION_KEY_PATTERN = /^cgak_[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PILOT_DEFAULT_DEVICE_LIMIT = 5;
const DEFAULT_ACTIVATION_KEY_LIFETIME_HOURS = 24;
const DEFAULT_OFFLINE_GRACE_DAYS = 7;

export class DesktopEnrollmentError extends Error {
  constructor(message, code = "DESKTOP_ENROLLMENT_REJECTED", status = 400) {
    super(message);
    this.name = "DesktopEnrollmentError";
    this.code = code;
    this.status = status;
  }
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function addMilliseconds(date, milliseconds) {
  return new Date(date.getTime() + milliseconds);
}

function safeInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function requiredInteger(value, fieldName, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new DesktopEnrollmentError(
      `${fieldName} must be an integer between ${minimum} and ${maximum}.`,
      "DESKTOP_POLICY_INPUT_INVALID",
      400,
    );
  }
  return parsed;
}

function normalizeOrigin(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new DesktopEnrollmentError("Desktop activation requires a TLS API origin.", "DESKTOP_API_ORIGIN_INVALID", 503);
  }
  return parsed.origin;
}

export function normalizeDevicePublicKey(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DesktopEnrollmentError("The device public key is invalid.", "DEVICE_PUBLIC_KEY_INVALID", 400);
  }
  const jwk = {
    kty: value.kty,
    crv: value.crv,
    x: value.x,
  };
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x || "") || value.d) {
    throw new DesktopEnrollmentError("The device public key is invalid.", "DEVICE_PUBLIC_KEY_INVALID", 400);
  }
  return Object.freeze(jwk);
}

export function devicePublicKeyThumbprint(jwkValue) {
  const jwk = normalizeDevicePublicKey(jwkValue);
  return sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }));
}

export function createActivationKeyHasher({ pepper } = {}) {
  const secret = String(pepper || "");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new TypeError("A desktop activation-key pepper of at least 32 bytes is required.");
  }
  return Object.freeze({
    hash(activationKey) {
      return crypto.createHmac("sha256", secret).update(String(activationKey || ""), "utf8").digest("hex");
    },
  });
}

export function createEnrollmentDocumentSigner({ privateKey, keyId } = {}) {
  if (!privateKey) throw new TypeError("An Ed25519 enrollment signing private key is required.");
  if (!String(keyId || "").trim()) throw new TypeError("An enrollment signing key id is required.");
  const resolvedPrivateKey = privateKey?.type === "private"
    ? privateKey
    : crypto.createPrivateKey(privateKey);
  if (resolvedPrivateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("The enrollment signing key must be Ed25519.");
  }
  const resolvedKeyId = String(keyId).trim();
  return Object.freeze({
    keyId: resolvedKeyId,
    sign(payload) {
      const header = base64urlJson({ alg: "EdDSA", kid: resolvedKeyId, typ: "claimguard-enrollment+jwt" });
      const body = base64urlJson(payload);
      const signingInput = `${header}.${body}`;
      const signature = crypto.sign(null, Buffer.from(signingInput, "ascii"), resolvedPrivateKey).toString("base64url");
      return `${signingInput}.${signature}`;
    },
  });
}

function enrollmentPayload(device, issuedAt, offlineGraceExpiresAt = device.offlineGraceExpiresAt) {
  const expiresAt = asDate(device.expiresAt);
  const offlineExpiry = asDate(offlineGraceExpiresAt);
  return Object.freeze({
    iss: "claimguard-control-plane",
    aud: "claimguard-desktop",
    iat: Math.floor(issuedAt.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
    organisationId: device.organisationId,
    organisationDisplayName: device.organisationDisplayName,
    organisationSlug: device.organisationSlug,
    deviceEnrollmentId: device.deviceEnrollmentId,
    permittedApiOrigin: device.permittedApiOrigin,
    environment: device.environment,
    licenceExpiresAt: expiresAt.toISOString(),
    offlineGraceExpiresAt: offlineExpiry.toISOString(),
    signingKeyId: device.signingKeyId,
    documentVersion: device.documentVersion,
    cnf: { jkt: device.publicKeyThumbprint },
  });
}

function safeDeviceProjection(device) {
  if (!device) return null;
  const { devicePublicKey: _key, publicKeyThumbprint: _thumbprint, ...safe } = device;
  return safe;
}

export function createDesktopEnrollmentService({
  repositories,
  activationKeyHasher,
  enrollmentSigner,
  apiOrigin,
  environment = "production",
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  enrollmentLifetimeDays = 365,
  throttleWindowMs = 15 * 60_000,
  throttleMaxAttempts = 8,
  throttleBaseDelayMs = 500,
  throttleMaxDelayMs = 15 * 60_000,
} = {}) {
  if (!repositories?.desktopEnrollment || typeof repositories.runInTransaction !== "function") {
    throw new TypeError("Desktop enrollment repositories with transaction support are required.");
  }
  if (!activationKeyHasher?.hash || !enrollmentSigner?.sign) {
    throw new TypeError("Desktop activation hashing and enrollment signing are required.");
  }
  const permittedApiOrigin = normalizeOrigin(apiOrigin);
  const deploymentEnvironment = String(environment || "production").slice(0, 64);
  const allowsPilotDefault = !["production", "prod"].includes(deploymentEnvironment.toLowerCase());

  async function resolvePolicy(repository, organisationId) {
    const stored = await repository.getPolicy(organisationId);
    if (stored) return { ...stored, configured: true, source: "licensed" };
    return {
      organisationId,
      deviceLimit: allowsPilotDefault ? PILOT_DEFAULT_DEVICE_LIMIT : null,
      activationKeyLifetimeHours: DEFAULT_ACTIVATION_KEY_LIFETIME_HOURS,
      offlineGraceDays: DEFAULT_OFFLINE_GRACE_DAYS,
      configured: false,
      source: allowsPilotDefault ? "pilot_default" : "unconfigured",
    };
  }

  function requireEnrollmentAllowance(policy) {
    if (!Number.isInteger(policy?.deviceLimit)) {
      throw new DesktopEnrollmentError(
        "The licensed organisation does not have a configured desktop device allowance.",
        "DESKTOP_POLICY_UNCONFIGURED",
        409,
      );
    }
  }

  function usageProjection(policy, activeDevices) {
    const limit = Number.isInteger(policy?.deviceLimit) ? policy.deviceLimit : null;
    return {
      activeDevices,
      deviceLimit: limit,
      remainingCapacity: limit == null ? null : Math.max(0, limit - activeDevices),
      overLimit: limit != null && activeDevices > limit,
      enrollmentBlocked: limit == null || activeDevices >= limit,
    };
  }

  async function audit(repository, input) {
    return repository.recordAudit({ occurredAt: now(), ...input });
  }

  function signEnrollment(device, issuedAt = now(), offlineGraceExpiresAt = device.offlineGraceExpiresAt) {
    const payload = enrollmentPayload(device, issuedAt, offlineGraceExpiresAt);
    return {
      document: payload,
      signedEnrollment: enrollmentSigner.sign(payload),
    };
  }

  async function activationFailure({ bucketKey, sourceNetworkHash, failureCategory, organisationId = null, activationKeyId = null, correlationId = null }) {
    const timestamp = now();
    const repository = repositories.desktopEnrollment;
    const existing = await repository.getActivationRateLimit(bucketKey);
    const windowStartedAt = existing?.window_started_at ? asDate(existing.window_started_at) : null;
    const previousFailures = windowStartedAt && timestamp.getTime() - windowStartedAt.getTime() <= throttleWindowMs
      ? Number(existing.failure_count || 0)
      : 0;
    const failureCount = previousFailures + 1;
    const delay = Math.min(throttleBaseDelayMs * (2 ** Math.max(0, failureCount - 1)), throttleMaxDelayMs);
    await repository.recordActivationFailure({
      bucketKey,
      sourceNetworkHash,
      now: timestamp,
      blockedUntil: addMilliseconds(timestamp, delay),
      windowCutoff: addMilliseconds(timestamp, -throttleWindowMs),
    });
    await audit(repository, {
      organisationId,
      activationKeyId,
      actorType: "anonymous",
      action: "desktop_activation.attempt",
      outcome: "failure",
      failureCategory,
      sourceNetworkHash,
      correlationId,
    });
    throw new DesktopEnrollmentError(
      "The organisation activation key could not be verified.",
      failureCount >= throttleMaxAttempts ? "ACTIVATION_RATE_LIMITED" : "ACTIVATION_REJECTED",
      failureCount >= throttleMaxAttempts ? 429 : 401,
    );
  }

  return Object.freeze({
    async issueActivationKey({ organisationId, expiresInHours = null, maximumUses = 1 }, actor = {}) {
      if (!UUID_PATTERN.test(String(organisationId || "")) || !UUID_PATTERN.test(String(actor.id || ""))) {
        throw new DesktopEnrollmentError("The activation-key request is invalid.", "ACTIVATION_KEY_INPUT_INVALID", 400);
      }
      const repository = repositories.desktopEnrollment;
      const policy = await resolvePolicy(repository, organisationId);
      requireEnrollmentAllowance(policy);
      const usage = usageProjection(policy, await repository.countActiveDevices(organisationId, now()));
      if (usage.enrollmentBlocked) {
        throw new DesktopEnrollmentError(
          "The licensed organisation has reached its desktop device allowance.",
          "DEVICE_LIMIT_REACHED",
          409,
        );
      }
      const lifetimeHours = safeInteger(
        expiresInHours,
        policy.activationKeyLifetimeHours,
        1,
        Math.min(168, policy.activationKeyLifetimeHours),
      );
      const uses = safeInteger(maximumUses, 1, 1, 10000);
      const issuedAt = now();
      const expiresAt = addMilliseconds(issuedAt, lifetimeHours * 3_600_000);
      const activationKey = `cgak_${randomBytes(32).toString("base64url")}`;
      const activationKeyHash = activationKeyHasher.hash(activationKey);
      const result = await repositories.runInTransaction(async (transactionRepositories) => {
        const created = await transactionRepositories.desktopEnrollment.createActivationKey({
          organisationId,
          activationKeyHash,
          maximumUses: uses,
          issuedBy: actor.id,
          issuedAt,
          expiresAt,
        });
        await audit(transactionRepositories.desktopEnrollment, {
          organisationId,
          activationKeyId: created.activationKeyId,
          actorType: "user",
          actorId: actor.id,
          action: "activation_key.issued",
          outcome: "success",
          correlationId: actor.correlationId || null,
        });
        return created;
      });
      return {
        activationKeyId: result.activationKeyId,
        activationKey,
        expiresAt: expiresAt.toISOString(),
        maximumUses: uses,
      };
    },

    async activate({ activationKey, installationId, devicePublicKey }, metadata = {}) {
      const timestamp = now();
      const sourceNetworkHash = /^[a-f0-9]{64}$/.test(metadata.sourceNetworkHash || "")
        ? metadata.sourceNetworkHash
        : sha256("unavailable-source");
      const bucketKey = sha256(`desktop-activation:${sourceNetworkHash}`);
      const currentLimit = await repositories.desktopEnrollment.getActivationRateLimit(bucketKey);
      if (currentLimit?.blocked_until && asDate(currentLimit.blocked_until).getTime() > timestamp.getTime()) {
        throw new DesktopEnrollmentError(
          "The organisation activation key could not be verified.",
          "ACTIVATION_RATE_LIMITED",
          429,
        );
      }
      if (!ACTIVATION_KEY_PATTERN.test(String(activationKey || ""))) {
        return activationFailure({ bucketKey, sourceNetworkHash, failureCategory: "invalid_key", correlationId: metadata.correlationId });
      }
      if (!UUID_PATTERN.test(String(installationId || ""))) {
        throw new DesktopEnrollmentError("The installation identifier is invalid.", "INSTALLATION_ID_INVALID", 400);
      }
      const publicKey = normalizeDevicePublicKey(devicePublicKey);
      const publicKeyThumbprint = devicePublicKeyThumbprint(publicKey);
      const activationKeyHash = activationKeyHasher.hash(activationKey);

      let device;
      try {
        device = await repositories.runInTransaction(async (transactionRepositories) => {
          const repository = transactionRepositories.desktopEnrollment;
          const key = await repository.getActivationKeyByHash(activationKeyHash, { forUpdate: true });
          if (!key || key.status !== "pending" || key.revokedAt || asDate(key.expiresAt).getTime() <= timestamp.getTime() || key.useCount >= key.maximumUses) {
            throw Object.assign(new Error("activation_key_unavailable"), { activationRejected: true, key });
          }
          if (key.organisationStatus !== "active" || key.organisationActivationState !== "activated") {
            throw Object.assign(new Error("organisation_inactive"), { activationRejected: true, key });
          }
          if (key.organisationType !== "medical_scheme") {
            throw Object.assign(new Error("platform_desktop_not_supported"), { activationRejected: true, key });
          }
          const lockedOrganisation = await repository.lockOrganisationForDesktopEnrollment(key.organisationId);
          if (!lockedOrganisation) {
            throw Object.assign(new Error("organisation_unavailable"), { activationRejected: true, key });
          }
          const policy = await resolvePolicy(repository, key.organisationId);
          requireEnrollmentAllowance(policy);
          const activeDevices = await repository.countActiveDevices(key.organisationId, timestamp);
          if (activeDevices >= policy.deviceLimit) {
            throw new DesktopEnrollmentError(
              "The licensed organisation has reached its desktop device allowance.",
              "DEVICE_LIMIT_REACHED",
              409,
            );
          }
          const expiresAt = addMilliseconds(timestamp, safeInteger(enrollmentLifetimeDays, 365, 1, 3650) * 86_400_000);
          const offlineGraceExpiresAt = addMilliseconds(timestamp, policy.offlineGraceDays * 86_400_000);
          const previousDevice = await repository.getDeviceByInstallationId(installationId, { forUpdate: true });
          if (previousDevice && previousDevice.organisationId !== key.organisationId) {
            throw new DesktopEnrollmentError("This installation cannot be enrolled.", "DEVICE_ENROLLMENT_CONFLICT", 409);
          }
          const previousExpired = previousDevice
            && asDate(previousDevice.expiresAt).getTime() <= timestamp.getTime();
          if (previousDevice && previousDevice.status === "active" && !previousDevice.revokedAt && !previousExpired) {
            throw new DesktopEnrollmentError("This installation is already enrolled.", "DEVICE_ENROLLMENT_CONFLICT", 409);
          }
          const documentVersion = previousDevice ? previousDevice.documentVersion + 1 : 1;
          const enrollmentInput = {
            organisationId: key.organisationId,
            activationKeyId: key.activationKeyId,
            installationId,
            devicePublicKey: publicKey,
            publicKeyThumbprint,
            documentVersion,
            signingKeyId: enrollmentSigner.keyId,
            permittedApiOrigin,
            environment: deploymentEnvironment,
            activatedAt: timestamp,
            expiresAt,
            offlineGraceExpiresAt,
          };
          let created;
          if (previousDevice) {
            const reactivated = await repository.reactivateDevice({
              ...enrollmentInput,
              deviceEnrollmentId: previousDevice.deviceEnrollmentId,
            });
            if (!reactivated) {
              throw new DesktopEnrollmentError("This installation cannot be re-enrolled.", "DEVICE_ENROLLMENT_CONFLICT", 409);
            }
            created = { deviceEnrollmentId: previousDevice.deviceEnrollmentId };
          } else {
            created = await repository.createDevice(enrollmentInput);
          }
          const consumed = await repository.consumeActivationKey(key.activationKeyId, timestamp);
          if (!consumed) throw Object.assign(new Error("activation_key_raced"), { activationRejected: true, key });
          await audit(repository, {
            organisationId: key.organisationId,
            activationKeyId: key.activationKeyId,
            deviceEnrollmentId: created.deviceEnrollmentId,
            actorType: "device",
            actorId: created.deviceEnrollmentId,
            action: previousDevice ? "desktop_device.reactivated" : "desktop_device.activated",
            outcome: "success",
            sourceNetworkHash,
            correlationId: metadata.correlationId || null,
          });
          return {
            ...created,
            organisationId: key.organisationId,
            organisationDisplayName: key.organisationDisplayName,
            organisationSlug: key.organisationSlug,
            installationId,
            devicePublicKey: publicKey,
            publicKeyThumbprint,
            status: "active",
            documentVersion,
            signingKeyId: enrollmentSigner.keyId,
            permittedApiOrigin,
            environment: deploymentEnvironment,
            activatedAt: timestamp,
            lastSeenAt: timestamp,
            expiresAt,
            offlineGraceExpiresAt,
          };
        });
      } catch (error) {
        if (error instanceof DesktopEnrollmentError) throw error;
        if (error?.activationRejected) {
          return activationFailure({
            bucketKey,
            sourceNetworkHash,
            failureCategory: error.message,
            organisationId: error.key?.organisationId || null,
            activationKeyId: error.key?.activationKeyId || null,
            correlationId: metadata.correlationId || null,
          });
        }
        if (error?.code === "ER_DUP_ENTRY") {
          throw new DesktopEnrollmentError("This installation cannot be enrolled.", "DEVICE_ENROLLMENT_CONFLICT", 409);
        }
        throw error;
      }
      await repositories.desktopEnrollment.clearActivationRateLimit(bucketKey);
      return {
        ...signEnrollment(device, timestamp),
        device: safeDeviceProjection(device),
      };
    },

    async renewEnrollment(device) {
      const timestamp = now();
      const policy = await resolvePolicy(repositories.desktopEnrollment, device.organisationId);
      const offlineGraceExpiresAt = addMilliseconds(timestamp, policy.offlineGraceDays * 86_400_000);
      const renewed = await repositories.desktopEnrollment.renewDeviceGrace({
        deviceEnrollmentId: device.deviceEnrollmentId,
        seenAt: timestamp,
        offlineGraceExpiresAt,
      });
      if (!renewed) {
        throw new DesktopEnrollmentError(
          "This desktop device is no longer authorised.",
          "DEVICE_ENROLLMENT_INACTIVE",
          401,
        );
      }
      return signEnrollment({ ...device, offlineGraceExpiresAt }, timestamp, offlineGraceExpiresAt);
    },

    async getAdminSnapshot(organisationId) {
      const [policy, activationKeys, devices, auditHistory] = await Promise.all([
        resolvePolicy(repositories.desktopEnrollment, organisationId),
        repositories.desktopEnrollment.listActivationKeys(organisationId),
        repositories.desktopEnrollment.listDevices(organisationId),
        repositories.desktopEnrollment.listAudit(organisationId),
      ]);
      const activeDevices = devices.filter((device) => (
        device.status === "active"
        && !device.revokedAt
        && asDate(device.expiresAt).getTime() > now().getTime()
      )).length;
      return { policy, usage: usageProjection(policy, activeDevices), activationKeys, devices, auditHistory };
    },

    async setFleetPolicy({ organisationId, deviceLimit }, actor = {}) {
      if (!UUID_PATTERN.test(String(organisationId || "")) || !UUID_PATTERN.test(String(actor.id || ""))) {
        throw new DesktopEnrollmentError("The desktop fleet policy request is invalid.", "DESKTOP_POLICY_INPUT_INVALID", 400);
      }
      const normalizedLimit = requiredInteger(deviceLimit, "Device allowance", 1, 10000);
      const updatedAt = now();
      const result = await repositories.runInTransaction(async (transactionRepositories) => {
        const repository = transactionRepositories.desktopEnrollment;
        const organisation = await repository.lockOrganisationForDesktopEnrollment(organisationId);
        if (!organisation || organisation.organisationType !== "medical_scheme") {
          throw new DesktopEnrollmentError("Desktop fleet policy applies only to medical schemes.", "DESKTOP_POLICY_ORGANISATION_INVALID", 409);
        }
        const previous = await repository.getPolicy(organisationId);
        const updated = await repository.setPolicy({
          organisationId,
          deviceLimit: normalizedLimit,
          activationKeyLifetimeHours: previous?.activationKeyLifetimeHours || DEFAULT_ACTIVATION_KEY_LIFETIME_HOURS,
          offlineGraceDays: previous?.offlineGraceDays || DEFAULT_OFFLINE_GRACE_DAYS,
        });
        const details = {
          previousDeviceLimit: previous?.deviceLimit ?? null,
          deviceLimit: normalizedLimit,
        };
        const recorded = await audit(repository, {
          organisationId,
          actorType: "user",
          actorId: actor.id,
          action: "desktop_fleet_policy.updated",
          outcome: "success",
          details,
          correlationId: actor.correlationId || null,
          occurredAt: updatedAt,
        });
        return {
          policy: { ...updated, configured: true, source: "licensed" },
          auditEvent: {
            desktopAuditEventId: recorded.desktopAuditEventId,
            organisationId,
            actorType: "user",
            actorId: actor.id,
            action: "desktop_fleet_policy.updated",
            outcome: "success",
            details,
            correlationId: actor.correlationId || null,
            occurredAt: updatedAt.toISOString(),
          },
        };
      });
      const activeDevices = await repositories.desktopEnrollment.countActiveDevices(organisationId, updatedAt);
      return {
        policy: result.policy,
        usage: usageProjection(result.policy, activeDevices),
        auditEvent: result.auditEvent,
      };
    },

    async revokeActivationKey({ organisationId, activationKeyId, reason = "administrative" }, actor = {}) {
      const revokedAt = now();
      const revoked = await repositories.runInTransaction(async (transactionRepositories) => {
        const repository = transactionRepositories.desktopEnrollment;
        const changed = await repository.revokeActivationKey({
          organisationId,
          activationKeyId,
          revokedBy: actor.id,
          revokedAt,
          reason,
        });
        if (!changed) throw new DesktopEnrollmentError("The unused activation key was not found.", "ACTIVATION_KEY_NOT_REVOCABLE", 409);
        await audit(repository, {
          organisationId,
          activationKeyId,
          actorType: "user",
          actorId: actor.id,
          action: "activation_key.revoked",
          outcome: "success",
          correlationId: actor.correlationId || null,
        });
        return true;
      });
      return { revoked, revokedAt: revokedAt.toISOString() };
    },

    async revokeDevice({ organisationId, deviceEnrollmentId, reason = "administrative" }, actor = {}) {
      const revokedAt = now();
      const revoked = await repositories.runInTransaction(async (transactionRepositories) => {
        const repository = transactionRepositories.desktopEnrollment;
        const changed = await repository.revokeDevice({
          organisationId,
          deviceEnrollmentId,
          revokedBy: actor.id,
          revokedAt,
          reason,
        });
        if (!changed) throw new DesktopEnrollmentError("The active device was not found.", "DEVICE_NOT_REVOCABLE", 409);
        await audit(repository, {
          organisationId,
          deviceEnrollmentId,
          actorType: "user",
          actorId: actor.id,
          action: "desktop_device.revoked",
          outcome: "success",
          correlationId: actor.correlationId || null,
        });
        return true;
      });
      return { revoked, revokedAt: revokedAt.toISOString() };
    },
  });
}
