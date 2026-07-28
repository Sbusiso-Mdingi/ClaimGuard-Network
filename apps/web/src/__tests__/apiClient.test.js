import { describe, expect, test } from "vitest";
import {
  ApiError,
  safeApiErrorMessage,
} from "../lib/apiClient";

describe("safeApiErrorMessage", () => {
  test("preserves a safe service message and request ID", () => {
    const error = new ApiError(
      "The investigation service is currently unavailable.",
      {
        status: 500,
        payload: { requestId: "req-safe-1" },
      },
    );

    expect(
      safeApiErrorMessage(error, "We couldn't load the investigation queue."),
    ).toBe(
      "The investigation service is currently unavailable. "
      + "Request ID: req-safe-1.",
    );
  });

  test("replaces raw database details with a recoverable message", () => {
    const error = new ApiError(
      "Incorrect arguments to mysqld_stmt_execute",
      {
        status: 500,
        payload: { requestId: "req-db-1" },
      },
    );

    const message = safeApiErrorMessage(
      error,
      "We couldn't load the investigation queue.",
    );
    expect(message).toBe(
      "We couldn't load the investigation queue. Request ID: req-db-1.",
    );
    expect(message).not.toMatch(/mysql|stmt_execute/i);
  });

  test.each([
    "MySQL connection refused",
    "mysqld_stmt_execute failed",
    "SQLSTATE[HY000]: General error",
    "Database driver returned an internal error",
  ])("filters database implementation detail: %s", (detail) => {
    expect(
      safeApiErrorMessage(
        new ApiError(detail, { status: 500 }),
        "Please try again.",
      ),
    ).toBe("Please try again.");
  });
});
