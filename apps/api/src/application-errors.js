export class ApplicationError extends Error {
  constructor(message, { code, status }) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
  }
}

export class UnauthenticatedError extends ApplicationError {
  constructor(message = "Authentication is required.") {
    super(message, { code: "UNAUTHENTICATED", status: 401 });
  }
}

export class ForbiddenError extends ApplicationError {
  constructor(message = "You do not have permission to perform this operation.") {
    super(message, { code: "FORBIDDEN", status: 403 });
  }
}

export class TenantMismatchError extends ForbiddenError {
  constructor(message = "Tenant authorization failed for this request.") {
    super(message);
    this.code = "TENANT_MISMATCH";
  }
}

export class TenantReportNotFoundError extends ApplicationError {
  constructor(message = "No detection report is available for the authenticated tenant.") {
    super(message, { code: "TENANT_REPORT_NOT_FOUND", status: 404 });
  }
}

export class OperationalRoutePolicyError extends ApplicationError {
  constructor(message = "Operational route policy mapping is missing for this request.") {
    super(message, { code: "OPERATIONAL_ROUTE_POLICY_MISSING", status: 503 });
  }
}

export function applicationErrorResponse(c, error) {
  return c.json(
    {
      available: false,
      code: error.code,
      message: error.message,
    },
    error.status,
  );
}
