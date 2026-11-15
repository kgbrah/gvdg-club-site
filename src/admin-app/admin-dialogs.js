import React from "react";
import { createPortal } from "react-dom";

import { useAccessibleDialog } from "../shared/a11y.js";

const h = React.createElement;
const subscribers = new Set();
const queue = [];
let activeDialog = null;
let nextId = 1;

function notify() {
  subscribers.forEach((subscriber) => subscriber(activeDialog));
}

function pumpQueue() {
  if (activeDialog || !queue.length) return;
  activeDialog = queue.shift();
  notify();
}

function requestDialog(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    queue.push({
      id: nextId++,
      resolve,
      title: opts.title || "Confirm action",
      message: opts.message || "",
      confirmText: opts.confirmText || "Confirm",
      cancelText: opts.cancelText || "Cancel",
      danger: opts.danger === true,
      pin: typeof opts.pin === "string" ? opts.pin : "",
      acknowledge: opts.acknowledge === true,
    });
    pumpQueue();
  });
}

function settle(value) {
  const dialog = activeDialog;
  if (!dialog) return;
  activeDialog = null;
  notify();
  dialog.resolve(value);
  pumpQueue();
}

export function adminConfirm(options) {
  return requestDialog(options || {});
}

export function adminShowPin(options) {
  const opts = options || {};
  return requestDialog({
    title: opts.title || "Temporary PIN",
    message: opts.message || "Copy this PIN before you close. It is shown once.",
    confirmText: opts.confirmText || "Done",
    pin: String(opts.pin || ""),
    acknowledge: true,
  });
}

export function AdminDialogs() {
  const [dialog, setDialog] = React.useState(activeDialog);
  const [copyState, setCopyState] = React.useState("");
  const titleId = dialog ? `adminDialogTitle-${dialog.id}` : "adminDialogTitle";
  const bodyId = dialog ? `adminDialogBody-${dialog.id}` : "adminDialogBody";
  const a11y = useAccessibleDialog({
    open: Boolean(dialog),
    onClose: () => settle(dialog && dialog.acknowledge ? true : false),
    labelledBy: titleId,
    label: dialog?.title || "Confirm action",
    closeOnBackdrop: !(dialog && dialog.acknowledge),
  });

  React.useEffect(() => {
    subscribers.add(setDialog);
    setDialog(activeDialog);
    return () => subscribers.delete(setDialog);
  }, []);

  React.useEffect(() => {
    setCopyState("");
  }, [dialog && dialog.id]);

  if (!dialog) return null;
  const confirmClass = `admin-btn admin-dialog-btn${dialog.danger ? " danger-strong" : ""}`;

  async function copyPin() {
    try {
      await navigator.clipboard.writeText(dialog.pin);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return createPortal(
    h("div", {
      className: "admin-dialog-overlay",
      "data-a11y-overlay": "true",
      ref: a11y.overlayRef,
      role: "presentation",
    }, h("div", {
      "aria-describedby": bodyId,
      "aria-labelledby": titleId,
      "aria-modal": a11y.isolated ? "true" : undefined,
      className: `admin-dialog${dialog.danger ? " danger" : ""}`,
      ref: a11y.panelRef,
      role: "dialog",
      tabIndex: -1,
    }, [
      h("h2", { className: "admin-dialog-title", id: titleId, key: "title" }, dialog.title),
      dialog.pin ? h("div", { className: "admin-dialog-pin", key: "pin" }, dialog.pin) : null,
      h("p", { className: "admin-dialog-message", id: bodyId, key: "message" }, dialog.message),
      copyState === "failed" ? h("p", { className: "al-note", key: "copy-error", role: "status" }, "Select the PIN and copy it manually.") : null,
      h("div", { className: "admin-dialog-actions", key: "actions" }, [
        dialog.pin ? h("button", { className: "admin-btn secondary admin-dialog-btn", key: "copy", onClick: () => { void copyPin(); }, type: "button" }, copyState === "copied" ? "Copied" : "Copy PIN") : null,
        dialog.acknowledge ? null : h("button", { className: "admin-btn secondary admin-dialog-btn", key: "cancel", onClick: () => settle(false), type: "button" }, dialog.cancelText),
        h("button", { className: confirmClass, key: "confirm", onClick: () => settle(true), type: "button" }, dialog.confirmText),
      ]),
    ])),
    document.body,
  );
}
