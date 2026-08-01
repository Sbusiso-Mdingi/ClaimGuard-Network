import crypto from "node:crypto";

import { applicationErrorResponse, ForbiddenError, UnauthenticatedError } from "./application-errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMPTY_BODY_DIGEST = crypto.createHash("sha256").update("").digest("base64url");

function proofError(message = "This desktop device could not be verified.", code = "DEVICE_PROOF_REJECTED", status = 401) {
  const error = status === 401 ? new UnauthenticatedError(message) : new ForbiddenError(message);
  error.code = code;
  error.status = status;
  return error;
}

function parseSegment(segment) {
  if (!segment || segment.length > 8192) throw proofError();
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw proofError();
  }
}

function parseProof(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw proofError();
  return {
    encodedHeader: parts[0],
    encodedPayload: parts[1],
    signature: parts[2],
    header: parseSegment(parts[0]),
    payload: parseSegment(parts[1]),
  };
}

function expectedTargetUri(request, permittedApiOrigin) {
  const requestUrl = new URL(request.url);
  const permitted = new URL(permittedApiOrigin);
  return `${permitted.origin}${requestUrl.pathname}`;
}

async function requestBodyDigest(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return EMPTY_BODY_DIGEST;
  const bytes = Buffer.from(await request.clone().arrayBuffer());
  return crypto.createHash("sha256").update(bytes).digest("base64url");
}

export function createDesktopDeviceProofVerifier({
  desktopEnrollmentRepository,
  now = () => new Date(),
  maximumClockSkewSeconds = 300,
  proofLifetimeSeconds = 600,
} = {}) {
  if (!desktopEnrollmentRepository?.getDeviceById || !desktopEnrollmentRepository?.consumeProofNonce) {
    throw new TypeError("A desktop enrollment repository is required for device proof verification.");
  }

  return Object.freeze({
    async verify(request) {
      const proof = parseProof(request.headers.get("dpop"));
      if (
        proof.header?.alg !== "EdDSA"
        || proof.header?.typ !== "dpop+jwt"
        || !UUID_PATTERN.test(String(proof.header?.kid || ""))
      ) {
        throw proofError();
      }
      const device = await desktopEnrollmentRepository.getDeviceById(proof.header.kid);
      const timestamp = now();
      if (
        !device
        || device.status !== "active"
        || device.revokedAt
        || new Date(device.expiresAt).getTime() <= timestamp.getTime()
      ) {
        throw proofError("This desktop device is no longer authorised.", "DEVICE_ENROLLMENT_INACTIVE", 401);
      }
      const payload = proof.payload || {};
      const issuedAt = Number(payload.iat);
      const ageSeconds = Math.abs(timestamp.getTime() / 1000 - issuedAt);
      if (
        payload.deviceEnrollmentId !== device.deviceEnrollmentId
        || !Number.isFinite(issuedAt)
        || ageSeconds > maximumClockSkewSeconds
        || typeof payload.jti !== "string"
        || payload.jti.length < 16
        || payload.jti.length > 128
        || String(payload.htm || "").toUpperCase() !== request.method.toUpperCase()
        || payload.htu !== expectedTargetUri(request, device.permittedApiOrigin)
        || payload.body_sha256 !== await requestBodyDigest(request)
      ) {
        throw proofError();
      }
      let publicKey;
      try {
        publicKey = crypto.createPublicKey({ key: device.devicePublicKey, format: "jwk" });
      } catch {
        throw proofError();
      }
      const verified = crypto.verify(
        null,
        Buffer.from(`${proof.encodedHeader}.${proof.encodedPayload}`, "ascii"),
        publicKey,
        Buffer.from(proof.signature, "base64url"),
      );
      if (!verified) throw proofError();
      const nonceHash = crypto.createHash("sha256")
        .update(`${device.deviceEnrollmentId}:${payload.jti}`, "utf8")
        .digest("hex");
      const consumed = await desktopEnrollmentRepository.consumeProofNonce({
        nonceHash,
        deviceEnrollmentId: device.deviceEnrollmentId,
        issuedAt: new Date(issuedAt * 1000),
        expiresAt: new Date(timestamp.getTime() + proofLifetimeSeconds * 1000),
      });
      if (!consumed) throw proofError("This desktop request has already been used.", "DEVICE_PROOF_REPLAYED", 401);
      await desktopEnrollmentRepository.touchDevice(device.deviceEnrollmentId, timestamp);
      return device;
    },
  });
}

export function createDesktopDeviceProofMiddleware({ verifier } = {}) {
  if (!verifier?.verify) throw new TypeError("A desktop device proof verifier is required.");
  return async (c, next) => {
    const path = c.req.path;
    if (!path.startsWith("/desktop/") || path === "/desktop/activate") return next();
    try {
      const device = await verifier.verify(c.req.raw);
      c.set("desktopDevice", device);
      c.req.raw.desktopDevice = device;
      return next();
    } catch (error) {
      return applicationErrorResponse(c, error?.status ? error : proofError());
    }
  };
}

export function createDesktopOrganisationEnforcementMiddleware() {
  return async (c, next) => {
    const device = c.get("desktopDevice") || null;
    if (!device) return next();
    const auth = c.get("authContext") || null;
    const dataPlane = c.get("dataPlaneContext") || null;
    if (auth?.is_authenticated && auth.organisation_id !== device.organisationId) {
      return applicationErrorResponse(c, proofError(
        "This account is not authorised for the organisation licensed on this device.",
        "DESKTOP_ORGANISATION_MISMATCH",
        403,
      ));
    }
    if (
      dataPlane
      && (
        dataPlane.organisationId !== device.organisationId
        || (auth?.organisation_id && dataPlane.organisationId !== auth.organisation_id)
      )
    ) {
      return applicationErrorResponse(c, proofError(
        "This account is not authorised for the organisation licensed on this device.",
        "DESKTOP_ROUTE_MISMATCH",
        403,
      ));
    }
    return next();
  };
}

export { EMPTY_BODY_DIGEST };
