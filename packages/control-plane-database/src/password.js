import argon2 from "argon2";

export const ARGON2ID_VERSION = 1;
export const DEFAULT_ARGON2ID_PARAMETERS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
});

export async function hashPassword(password, parameters = DEFAULT_ARGON2ID_PARAMETERS) {
  if (typeof password !== "string" || password.length === 0) throw new TypeError("A non-empty password is required.");
  return argon2.hash(password, { ...DEFAULT_ARGON2ID_PARAMETERS, ...parameters, type: argon2.argon2id });
}

export async function verifyPassword(passwordHash, password) {
  if (typeof passwordHash !== "string" || !passwordHash.startsWith("$argon2id$")) return false;
  if (typeof password !== "string") return false;
  try {
    return await argon2.verify(passwordHash, password, { type: argon2.argon2id });
  } catch {
    return false;
  }
}

export function passwordHashNeedsRehash(passwordHash, parameters = DEFAULT_ARGON2ID_PARAMETERS) {
  if (typeof passwordHash !== "string" || !passwordHash.startsWith("$argon2id$")) return true;
  return argon2.needsRehash(passwordHash, {
    memoryCost: parameters.memoryCost,
    timeCost: parameters.timeCost,
    parallelism: parameters.parallelism,
    hashLength: parameters.hashLength,
  });
}

export function passwordParametersRecord(parameters = DEFAULT_ARGON2ID_PARAMETERS) {
  return {
    algorithm: "argon2id",
    version: ARGON2ID_VERSION,
    memoryCost: parameters.memoryCost,
    timeCost: parameters.timeCost,
    parallelism: parameters.parallelism,
    hashLength: parameters.hashLength,
  };
}
