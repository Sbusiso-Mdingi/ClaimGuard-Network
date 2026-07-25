import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../lib/apiClient";

const LEDGER_POLL_INTERVAL_MS = 15000;

function describeLedger(payload) {
  if (payload?.available !== true) return "Unavailable";
  return payload.entry ? "Connected" : "Connected · Empty";
}

export function useLedgerStatus({ enabled = true } = {}) {
  const [state, setState] = useState({ status: enabled ? "Checking" : "Unavailable", error: null });

  const refresh = useCallback(async () => {
    if (!enabled) {
      setState({ status: "Unavailable", error: null });
      return;
    }

    setState((previous) => ({ ...previous, status: previous.status === "Unavailable" ? "Checking" : previous.status, error: null }));
    try {
      const response = await apiRequest("/ledger/latest", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.available !== true) {
        throw new Error(payload?.message || `Ledger unavailable (${response.status})`);
      }
      setState({ status: describeLedger(payload), error: null });
    } catch (error) {
      setState({ status: "Unavailable", error: error instanceof Error ? error.message : "Ledger unavailable." });
    }
  }, [enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(refresh, LEDGER_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  return { ...state, refresh };
}

export { describeLedger };
