import React from "react";
import { PhoneActivityPairing } from "../shared/phone-activity-view.js";
import { request, storageGet, TOKEN_KEY } from "./api.js";
import { useMemberContext } from "./member-context.js";

export function MemberPhoneActivityPanel() {
  const { sub } = useMemberContext();
  const token = storageGet(TOKEN_KEY);
  const api = React.useCallback(async (path, options = {}) => {
    const response = await request(path, { ...options, token });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }, [token]);
  if (!sub || !token) return null;
  return React.createElement(PhoneActivityPairing, { api, ownerId: sub, showArchive: true });
}
