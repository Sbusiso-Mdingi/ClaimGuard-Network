import {
  DefaultAzureCredential,
} from "@azure/identity";

const ARM_SCOPE =
  "https://management.azure.com/.default";

const DEFAULT_API_VERSION =
  "2025-07-01";

const DEFAULT_TIMEOUT_MS =
  15_000;

function enabled(
  value,
) {
  return (
    String(
      value ?? "",
    )
      .trim()
      .toLowerCase()
    === "true"
  );
}

function requiredSetting(
  env,
  name,
) {
  const value =
    String(
      env[name] ?? "",
    ).trim();

  if (
    !value
  ) {
    throw new ProvisioningJobTriggerError(
      `${name} is required.`,
      {
        code:
          "PROVISIONING_JOB_TRIGGER_NOT_CONFIGURED",
      },
    );
  }

  return value;
}

function safeJson(
  text,
) {
  if (
    !text
  ) {
    return null;
  }

  try {
    return JSON.parse(
      text,
    );
  } catch {
    return null;
  }
}

export class ProvisioningJobTriggerError
  extends Error {
  constructor(
    message,
    {
      code =
        "PROVISIONING_JOB_TRIGGER_FAILED",
      status = null,
      cause = null,
    } = {},
  ) {
    super(
      message,
      {
        cause,
      },
    );

    this.name =
      "ProvisioningJobTriggerError";

    this.code =
      code;

    this.status =
      status;
  }
}

export function createProvisioningJobTrigger(
  {
    env =
      process.env,

    credential =
      new DefaultAzureCredential(),

    fetchImpl =
      globalThis.fetch,

    timeoutMs =
      DEFAULT_TIMEOUT_MS,
  } = {},
) {
  if (
    typeof fetchImpl
    !== "function"
  ) {
    throw new TypeError(
      "fetchImpl must be a function.",
    );
  }

  if (
    !credential
    || typeof credential.getToken
      !== "function"
  ) {
    throw new TypeError(
      "credential must expose getToken().",
    );
  }

  return async function triggerProvisioningJob(
    {
      operationId =
        null,

      organisationId =
        null,
    } = {},
  ) {
    if (
      !enabled(
        env
          .AZURE_PROVISIONING_JOB_TRIGGER_ENABLED,
      )
    ) {
      throw new ProvisioningJobTriggerError(
        "Automatic provisioning-worker triggering is disabled.",
        {
          code:
            "PROVISIONING_JOB_TRIGGER_DISABLED",
        },
      );
    }

    const subscriptionId =
      requiredSetting(
        env,
        "AZURE_PROVISIONING_JOB_SUBSCRIPTION_ID",
      );

    const resourceGroup =
      requiredSetting(
        env,
        "AZURE_PROVISIONING_JOB_RESOURCE_GROUP",
      );

    const jobName =
      requiredSetting(
        env,
        "AZURE_PROVISIONING_JOB_NAME",
      );

    const apiVersion =
      String(
        env
          .AZURE_PROVISIONING_JOB_API_VERSION
        || DEFAULT_API_VERSION,
      ).trim();

    let accessToken;

    try {
      accessToken =
        await credential.getToken(
          ARM_SCOPE,
        );
    } catch (
      error
    ) {
      throw new ProvisioningJobTriggerError(
        "Azure managed-identity token acquisition failed.",
        {
          code:
            "PROVISIONING_JOB_TOKEN_FAILED",

          cause:
            error,
        },
      );
    }

    if (
      !accessToken?.token
    ) {
      throw new ProvisioningJobTriggerError(
        "Azure managed identity returned no access token.",
        {
          code:
            "PROVISIONING_JOB_TOKEN_EMPTY",
        },
      );
    }

    const url =
      (
        "https://management.azure.com"
        + `/subscriptions/${encodeURIComponent(subscriptionId)}`
        + `/resourceGroups/${encodeURIComponent(resourceGroup)}`
        + "/providers/Microsoft.App/jobs"
        + `/${encodeURIComponent(jobName)}`
        + `/start?api-version=${encodeURIComponent(apiVersion)}`
      );

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () =>
          controller.abort(),
        timeoutMs,
      );

    let response;

    try {
      response =
        await fetchImpl(
          url,
          {
            method:
              "POST",

            headers: {
              authorization:
                `Bearer ${accessToken.token}`,

              "content-type":
                "application/json",
            },

            body:
              "{}",

            signal:
              controller.signal,
          },
        );
    } catch (
      error
    ) {
      const timedOut =
        error?.name
        === "AbortError";

      throw new ProvisioningJobTriggerError(
        timedOut
          ? "Azure provisioning-worker start request timed out."
          : "Azure provisioning-worker start request failed.",
        {
          code:
            timedOut
              ? "PROVISIONING_JOB_TRIGGER_TIMEOUT"
              : "PROVISIONING_JOB_TRIGGER_REQUEST_FAILED",

          cause:
            error,
        },
      );
    } finally {
      clearTimeout(
        timeout,
      );
    }

    const responseText =
      await response.text();

    const responseBody =
      safeJson(
        responseText,
      );

    if (
      !response.ok
    ) {
      throw new ProvisioningJobTriggerError(
        "Azure rejected the provisioning-worker start request.",
        {
          code:
            responseBody
              ?.error
              ?.code
            || "PROVISIONING_JOB_TRIGGER_REJECTED",

          status:
            response.status,
        },
      );
    }

    return Object.freeze(
      {
        status:
          "started",

        operationId,

        organisationId,

        jobName,

        azureStatus:
          response.status,

        executionName:
          responseBody
            ?.name
          || null,
      },
    );
  };
}

export const triggerProvisioningJob =
  createProvisioningJobTrigger();
