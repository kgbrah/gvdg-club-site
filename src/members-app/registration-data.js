import React from "react";

import { requestJson } from "./api.js";
import { useSessionToken } from "./session-token.js";

const h = React.createElement;
const RegistrationContext = React.createContext(null);

const idleState = {
  status: "idle",
  events: [],
  registrations: [],
  casualRequests: [],
  paymentsConfig: { enabled: false },
};

export function RegistrationProvider({ children }) {
  const token = useSessionToken();
  const [version, setVersion] = React.useState(0);
  const [state, setState] = React.useState(() => ({
    ...idleState,
    status: token ? "loading" : "idle",
  }));

  React.useEffect(() => {
    if (!token) {
      setState({ ...idleState });
      return undefined;
    }
    const controller = new AbortController();
    setState((current) => ({ ...current, status: "loading" }));
    Promise.all([
      requestJson("/payments/config", { signal: controller.signal }).catch(() => ({ enabled: false })),
      requestJson("/registration/open", { signal: controller.signal }).catch(() => ({ events: [] })),
      requestJson("/my-registrations", { signal: controller.signal, token }).catch(() => ({ registrations: [] })),
      requestJson("/casual-rounds", { signal: controller.signal, token }).catch(() => ({ requests: [] })),
    ]).then(([paymentsConfig, eventData, registrationData, casualData]) => {
      setState({
        status: "ready",
        paymentsConfig: paymentsConfig || { enabled: false },
        events: Array.isArray(eventData.events) ? eventData.events : [],
        registrations: Array.isArray(registrationData.registrations) ? registrationData.registrations : [],
        casualRequests: Array.isArray(casualData.requests) ? casualData.requests : [],
      });
    }).catch((error) => {
      if (error.name !== "AbortError") setState((current) => ({ ...current, status: "error" }));
    });
    return () => controller.abort();
  }, [token, version]);

  const reload = React.useCallback(() => setVersion((current) => current + 1), []);
  const value = React.useMemo(() => ({ token, state, reload }), [token, state, reload]);
  return h(RegistrationContext.Provider, { value }, children);
}

export function useRegistrationData() {
  const value = React.useContext(RegistrationContext);
  if (!value) throw new Error("MemberRegistrationPanel requires RegistrationProvider");
  return value;
}
