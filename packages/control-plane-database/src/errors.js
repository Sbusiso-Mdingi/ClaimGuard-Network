export class ControlPlaneError extends Error {
  constructor(message, { code = "CONTROL_PLANE_ERROR", status = 500, details = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ControlPlaneConfigurationError extends ControlPlaneError {
  constructor(message) {
    super(message, { code: "CONTROL_PLANE_CONFIGURATION_ERROR", status: 500 });
  }
}

export class ControlPlaneValidationError extends ControlPlaneError {
  constructor(message, code = "CONTROL_PLANE_VALIDATION_ERROR", details = null) {
    super(message, { code, status: 400, details });
  }
}

export class ControlPlaneNotFoundError extends ControlPlaneError {
  constructor(message, code = "CONTROL_PLANE_NOT_FOUND") {
    super(message, { code, status: 404 });
  }
}

export class AuthenticationRejectedError extends ControlPlaneError {
  constructor(internalReason = "invalid_credentials") {
    super("The organisation or credentials could not be verified.", { code: "AUTHENTICATION_FAILED", status: 401 });
    Object.defineProperty(this, "internalReason", { value: internalReason, enumerable: false });
  }
}

export class SessionRejectedError extends ControlPlaneError {
  constructor(internalReason = "invalid_session", { organisationId = null } = {}) {
    super("The authenticated session is not valid.", { code: "SESSION_INVALID", status: 401 });
    Object.defineProperty(this, "internalReason", { value: internalReason, enumerable: false });
    Object.defineProperty(this, "organisationId", { value: organisationId, enumerable: false });
  }
}

export class ControlPlaneConflictError extends ControlPlaneError {
  constructor(message, code = "CONTROL_PLANE_CONFLICT", details = null) {
    super(message, { code, status: 409, details });
  }
}

export class MigrationChecksumMismatchError extends ControlPlaneError {
  constructor(migrationId) {
    super(`Applied control-plane migration ${migrationId} no longer matches its recorded checksum.`, {
      code: "CONTROL_PLANE_MIGRATION_CHECKSUM_MISMATCH",
      status: 500,
      details: { migrationId },
    });
  }
}

export class MigrationExecutionError extends ControlPlaneError {
  constructor(migrationId, statementIndex, cause) {
    super(`Control-plane migration ${migrationId} failed at statement ${statementIndex}.`, {
      code: "CONTROL_PLANE_MIGRATION_FAILED",
      status: 500,
      details: { migrationId, statementIndex },
    });
    this.cause = cause;
  }
}
