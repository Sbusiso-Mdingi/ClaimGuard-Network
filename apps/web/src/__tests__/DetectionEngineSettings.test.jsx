import React from "react";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

vi.mock(
  "../lib/apiClient",
  () => ({
    apiJson: vi.fn(),
  }),
);

import {
  apiJson,
} from "../lib/apiClient";
import {
  DetectionEngineSettings,
} from "../features/investigator/DetectionEngineSettings";


const DETERMINISTIC_STRATEGY = {
  strategyType: "deterministic_rules",
  modelDeploymentId: null,
};

const APPROVED_DEPLOYMENT_ID =
  "claimguard-claim-fraud-ensemble:1.1.0";

const APPROVED_MODEL_STRATEGY = {
  strategyType: "approved_model",
  modelDeploymentId:
    APPROVED_DEPLOYMENT_ID,
};


function apiStrategyResponse(
  strategy,
) {
  return {
    available: true,
    strategy,
  };
}


async function renderLoadedComponent({
  strategy =
    DETERMINISTIC_STRATEGY,
  tenantId = "tenant-alpha",
} = {}) {
  apiJson.mockResolvedValueOnce(
    apiStrategyResponse(
      strategy,
    ),
  );

  render(
    <DetectionEngineSettings
      tenantId={tenantId}
    />,
  );

  await screen.findByRole(
    "heading",
    {
      name: "Detection Strategy",
    },
  );

  return {
    user: userEvent.setup(),
  };
}


describe(
  "DetectionEngineSettings",
  () => {
    beforeEach(
      () => {
        vi.clearAllMocks();
      },
    );

    afterEach(
      () => {
        cleanup();
      },
    );

    test(
      "loads the tenant's active strategy through the canonical API client",
      async () => {
        await renderLoadedComponent();

        expect(
          apiJson,
        ).toHaveBeenCalledTimes(1);

        expect(
          apiJson,
        ).toHaveBeenCalledWith(
          "/detection/strategy",
          {
            cache: "no-store",
          },
        );

        expect(
          screen.getByRole(
            "radio",
            {
              name:
                /ClaimGuard Detection Engine/i,
            },
          ),
        ).toHaveAttribute(
          "aria-checked",
          "true",
        );

        expect(
          screen.getByRole(
            "radio",
            {
              name:
                /Approved ClaimGuard Model/i,
            },
          ),
        ).toHaveAttribute(
          "aria-checked",
          "false",
        );

        expect(
          screen.getByRole(
            "button",
            {
              name:
                "Save Strategy Configuration",
            },
          ),
        ).toBeDisabled();
      },
    );

    test(
      "activates an approved model with an audit reason",
      async () => {
        apiJson
          .mockResolvedValueOnce(
            apiStrategyResponse(
              DETERMINISTIC_STRATEGY,
            ),
          )
          .mockResolvedValueOnce(
            apiStrategyResponse(
              APPROVED_MODEL_STRATEGY,
            ),
          );

        render(
          <DetectionEngineSettings
            tenantId="tenant-alpha"
          />,
        );

        const user =
          userEvent.setup();

        await screen.findByRole(
          "heading",
          {
            name:
              "Detection Strategy",
          },
        );

        await user.click(
          screen.getByRole(
            "radio",
            {
              name:
                /Approved ClaimGuard Model/i,
            },
          ),
        );

        await user.type(
          screen.getByLabelText(
            "Approved model deployment ID",
          ),
          APPROVED_DEPLOYMENT_ID,
        );

        await user.type(
          screen.getByLabelText(
            "Reason for change",
          ),
          "Activate the approved production model after validation.",
        );

        const saveButton =
          screen.getByRole(
            "button",
            {
              name:
                "Save Strategy Configuration",
            },
          );

        expect(
          saveButton,
        ).toBeEnabled();

        await user.click(
          saveButton,
        );

        await waitFor(
          () => {
            expect(
              apiJson,
            ).toHaveBeenCalledTimes(2);
          },
        );

        const [
          requestPath,
          requestOptions,
        ] = apiJson.mock.calls[1];

        expect(
          requestPath,
        ).toBe(
          "/detection/strategy",
        );

        expect(
          requestOptions.method,
        ).toBe(
          "PUT",
        );

        expect(
          JSON.parse(
            requestOptions.body,
          ),
        ).toEqual({
          strategyType:
            "approved_model",

          modelDeploymentId:
            APPROVED_DEPLOYMENT_ID,

          changeReason:
            "Activate the approved production model after validation.",
        });

        expect(
          await screen.findByRole(
            "status",
          ),
        ).toHaveTextContent(
          "Detection strategy configuration saved.",
        );

        expect(
          screen.getByLabelText(
            "Reason for change",
          ),
        ).toHaveValue("");

        expect(
          screen.getByRole(
            "button",
            {
              name:
                "Save Strategy Configuration",
            },
          ),
        ).toBeDisabled();
      },
    );

    test(
      "clears the model deployment when switching back to deterministic rules",
      async () => {
        apiJson
          .mockResolvedValueOnce(
            apiStrategyResponse(
              APPROVED_MODEL_STRATEGY,
            ),
          )
          .mockResolvedValueOnce(
            apiStrategyResponse(
              DETERMINISTIC_STRATEGY,
            ),
          );

        render(
          <DetectionEngineSettings
            tenantId="tenant-alpha"
          />,
        );

        const user =
          userEvent.setup();

        await screen.findByDisplayValue(
          APPROVED_DEPLOYMENT_ID,
        );

        await user.click(
          screen.getByRole(
            "radio",
            {
              name:
                /ClaimGuard Detection Engine/i,
            },
          ),
        );

        await user.type(
          screen.getByLabelText(
            "Reason for change",
          ),
          "Return to deterministic rules during model maintenance.",
        );

        await user.click(
          screen.getByRole(
            "button",
            {
              name:
                "Save Strategy Configuration",
            },
          ),
        );

        await waitFor(
          () => {
            expect(
              apiJson,
            ).toHaveBeenCalledTimes(2);
          },
        );

        const [
          requestPath,
          requestOptions,
        ] = apiJson.mock.calls[1];

        expect(
          requestPath,
        ).toBe(
          "/detection/strategy",
        );

        expect(
          JSON.parse(
            requestOptions.body,
          ),
        ).toEqual({
          strategyType:
            "deterministic_rules",

          modelDeploymentId:
            null,

          changeReason:
            "Return to deterministic rules during model maintenance.",
        });

        expect(
          screen.queryByLabelText(
            "Approved model deployment ID",
          ),
        ).not.toBeInTheDocument();
      },
    );

    test(
      "does not permit an invalid model deployment identifier",
      async () => {
        const {
          user,
        } =
          await renderLoadedComponent();

        await user.click(
          screen.getByRole(
            "radio",
            {
              name:
                /Approved ClaimGuard Model/i,
            },
          ),
        );

        await user.type(
          screen.getByLabelText(
            "Approved model deployment ID",
          ),
          "https://unapproved.example/model",
        );

        await user.type(
          screen.getByLabelText(
            "Reason for change",
          ),
          "Attempt to activate an invalid deployment.",
        );

        expect(
          screen.getByRole(
            "button",
            {
              name:
                "Save Strategy Configuration",
            },
          ),
        ).toBeDisabled();

        expect(
          apiJson,
        ).toHaveBeenCalledTimes(1);
      },
    );

    test(
      "requires a non-empty audit reason before enabling a strategy change",
      async () => {
        const {
          user,
        } =
          await renderLoadedComponent();

        await user.click(
          screen.getByRole(
            "radio",
            {
              name:
                /Approved ClaimGuard Model/i,
            },
          ),
        );

        await user.type(
          screen.getByLabelText(
            "Approved model deployment ID",
          ),
          APPROVED_DEPLOYMENT_ID,
        );

        const saveButton =
          screen.getByRole(
            "button",
            {
              name:
                "Save Strategy Configuration",
            },
          );

        expect(
          saveButton,
        ).toBeDisabled();

        await user.type(
          screen.getByLabelText(
            "Reason for change",
          ),
          "Approved for controlled production use.",
        );

        expect(
          saveButton,
        ).toBeEnabled();
      },
    );

    test(
      "displays API loading failures without attempting a mutation",
      async () => {
        apiJson.mockRejectedValueOnce(
          new Error(
            "Detection strategy access is forbidden.",
          ),
        );

        render(
          <DetectionEngineSettings
            tenantId="tenant-alpha"
          />,
        );

        expect(
          await screen.findByRole(
            "alert",
          ),
        ).toHaveTextContent(
          "Detection strategy access is forbidden.",
        );

        expect(
          apiJson,
        ).toHaveBeenCalledTimes(1);
      },
    );

    test(
      "reloads strategy configuration when the tenant changes",
      async () => {
        apiJson
          .mockResolvedValueOnce(
            apiStrategyResponse(
              DETERMINISTIC_STRATEGY,
            ),
          )
          .mockResolvedValueOnce(
            apiStrategyResponse(
              APPROVED_MODEL_STRATEGY,
            ),
          );

        const {
          rerender,
        } = render(
          <DetectionEngineSettings
            tenantId="tenant-alpha"
          />,
        );

        expect(
          await screen.findByRole(
            "radio",
            {
              name:
                /ClaimGuard Detection Engine/i,
            },
          ),
        ).toHaveAttribute(
          "aria-checked",
          "true",
        );

        rerender(
          <DetectionEngineSettings
            tenantId="tenant-beta"
          />,
        );

        await waitFor(
          () => {
            expect(
              apiJson,
            ).toHaveBeenCalledTimes(2);
          },
        );

        expect(
          await screen.findByDisplayValue(
            APPROVED_DEPLOYMENT_ID,
          ),
        ).toBeInTheDocument();

        expect(
          screen.getByRole(
            "radio",
            {
              name:
                /Approved ClaimGuard Model/i,
            },
          ),
        ).toHaveAttribute(
          "aria-checked",
          "true",
        );
      },
    );
  },
);
