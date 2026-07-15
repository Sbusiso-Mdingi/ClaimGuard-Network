import {
  FraudRegistryConflictError,
  FraudRegistryNotFoundError,
  FraudRegistryValidationError,
  InvestigationConflictError,
  InvestigationNotFoundError,
  InvestigationValidationError,
} from "@claimguard/database";

export function investigationRepositoryUnavailable(c) {
  return c.json(
    {
      available: false,
      message: "Investigation persistence is not configured.",
    },
    503,
  );
}

export function sharedRegistryUnavailable(c) {
  return c.json(
    {
      available: false,
      message: "Shared fraud registry is not configured.",
    },
    503,
  );
}

export function investigationErrorResponse(c, error) {
  if (error instanceof InvestigationNotFoundError || error?.code === "investigation_not_found") {
    return c.json({ available: false, message: error.message }, 404);
  }

  if (
    error instanceof InvestigationConflictError ||
    error?.code === "invalid_status_transition" ||
    error?.code === "confirmation_status_not_permitted" ||
    error?.code === "fraud_already_confirmed" ||
    error?.code === "ER_DUP_ENTRY"
  ) {
    return c.json({ available: false, message: error.message }, 409);
  }

  if (error instanceof InvestigationValidationError) {
    return c.json({ available: false, message: error.message }, 400);
  }

  return c.json(
    {
      available: false,
      message: error?.message || "Investigation operation failed.",
    },
    400,
  );
}

export async function loadInvestigationOrFail(c, investigationService, investigationId) {
  const investigation = await investigationService.getInvestigationById(investigationId);
  if (!investigation) {
    return {
      ok: false,
      response: c.json(
        {
          available: false,
          message: "The investigation was not found in the active tenant.",
        },
        404,
      ),
    };
  }

  return {
    ok: true,
    investigation,
  };
}

export function registryErrorResponse(c, error) {
  if (error instanceof FraudRegistryNotFoundError || error?.code === "fraud_registry_not_found") {
    return c.json({ available: false, message: error.message }, 404);
  }

  if (error instanceof FraudRegistryConflictError) {
    return c.json({ available: false, message: error.message }, 409);
  }

  if (error instanceof FraudRegistryValidationError) {
    return c.json({ available: false, message: error.message }, 400);
  }

  return c.json(
    {
      available: false,
      message: error?.message || "Registry operation failed.",
    },
    400,
  );
}
