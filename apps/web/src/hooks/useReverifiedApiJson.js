import { useCallback } from "react";
import { useReverification } from "@clerk/react";
import { ApiError, apiRequest } from "../lib/apiClient";

export function useReverifiedApiJson() {
  const reverifiedRequest = useReverification(apiRequest);
  return useCallback(async (path, options = {}) => {
    const response = await reverifiedRequest(path, options);
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(payload?.message || `API request failed (${response.status}).`, {
        status: response.status,
        code: payload?.code || null,
        payload,
      });
    }
    return payload;
  }, [reverifiedRequest]);
}
