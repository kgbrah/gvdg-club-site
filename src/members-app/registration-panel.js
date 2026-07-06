import React from "react";

import { TOKEN_KEY, requestJson, storageGet } from "./api.js";
import { useMemberContext } from "./member-context.js";
import { CasualRoundsSection } from "./registration-casual.js";
import { EventRegistrationSections } from "./registration-events.js";

const h = React.createElement;

function useSessionToken() {
  const [token, setToken] = React.useState(() => storageGet(TOKEN_KEY));

  React.useEffect(() => {
    function update() {
      setToken(storageGet(TOKEN_KEY));
    }
    window.addEventListener("gvdg:member-dashboard-ready", update);
    window.addEventListener("gvdg:member-profile-updated", update);
    return () => {
      window.removeEventListener("gvdg:member-dashboard-ready", update);
      window.removeEventListener("gvdg:member-profile-updated", update);
    };
  }, []);

  return token;
}

function visibleParent(token) {
  const parent = document.getElementById("clubRegister");
  if (parent && token) parent.style.display = "";
}

export function MemberRegistrationPanel() {
  const context = useMemberContext();
  const token = useSessionToken();
  const [version, setVersion] = React.useState(0);
  const [state, setState] = React.useState({
    status: token ? "loading" : "idle",
    events: [],
    registrations: [],
    casualRequests: [],
    paymentsConfig: { enabled: false },
  });

  React.useEffect(() => {
    visibleParent(token);
  }, [token]);

  React.useEffect(() => {
    if (!token) {
      setState((current) => ({ ...current, status: "idle", events: [], registrations: [], casualRequests: [] }));
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

  if (!token) return null;

  return h("div", { className: "react-registration-panel", "data-react-registration-panel": state.status }, [
    h("h3", { className: "my-dashboard-title", key: "title" }, "Register for Events"),
    state.status === "loading" ? h("p", { className: "dash-note", key: "loading" }, "Loading registration options...") : null,
    state.status === "error" ? h("p", { className: "dash-note", key: "error" }, "Registration is temporarily unavailable. Please refresh or try again in a minute.") : null,
    state.status !== "error" ? h("div", { key: "content" }, [
      h(EventRegistrationSections, {
        events: state.events,
        registrations: state.registrations,
        token,
        paymentsConfig: state.paymentsConfig,
        onReload: reload,
        key: "events",
      }),
      h(CasualRoundsSection, {
        token,
        requests: state.casualRequests,
        viewerSub: context.sub,
        onReload: reload,
        key: "casual",
      }),
    ]) : null,
  ]);
}
