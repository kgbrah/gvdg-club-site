import React from "react";
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
  return new Promise((resolve) => {
    queue.push({
      id: nextId++,
      resolve,
      type: options.type || "alert",
      tone: options.tone || "",
      title: options.title || "Notice",
      message: options.message || "",
      confirmText: options.confirmText || "OK",
      cancelText: options.cancelText || "Cancel",
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

export function memberAlert(options) {
  return requestDialog({ ...options, type: "alert" });
}

export function memberConfirm(options) {
  return requestDialog({ ...options, type: "confirm" });
}

export function MemberDialogs() {
  const [dialog, setDialog] = React.useState(activeDialog);
  const titleId = dialog ? `memberDialogTitle-${dialog.id}` : "memberDialogTitle";
  const bodyId = dialog ? `memberDialogBody-${dialog.id}` : "memberDialogBody";
  const a11y = useAccessibleDialog({
    open: Boolean(dialog),
    onClose: () => settle(dialog && dialog.type === "confirm" ? false : true),
    labelledBy: titleId,
    label: dialog?.title || "Notice",
  });

  React.useEffect(() => {
    subscribers.add(setDialog);
    setDialog(activeDialog);
    return () => subscribers.delete(setDialog);
  }, []);

  if (!dialog) return null;
  const confirmClass = `member-dialog-btn primary${dialog.tone === "danger" ? " danger" : ""}`;

  return h("div", {
    className: "member-dialog-overlay active",
    "data-a11y-overlay": "true",
    role: "presentation",
    ref: a11y.overlayRef,
  }, h("div", {
    className: `member-dialog${dialog.tone ? ` ${dialog.tone}` : ""}`,
    role: "dialog",
    "aria-modal": a11y.isolated ? "true" : undefined,
    "aria-labelledby": titleId,
    "aria-describedby": bodyId,
    ref: a11y.panelRef,
    tabIndex: -1,
  }, [
    h("div", { className: "member-dialog-title", id: titleId, key: "title" }, dialog.title),
    h("p", { className: "member-dialog-message", id: bodyId, key: "message" }, dialog.message),
    h("div", { className: "member-dialog-actions", key: "actions" }, [
      dialog.type === "confirm"
        ? h("button", { type: "button", className: "member-dialog-btn secondary", onClick: () => settle(false), key: "cancel" }, dialog.cancelText)
        : null,
      h("button", { type: "button", className: confirmClass, onClick: () => settle(true), key: "confirm" }, dialog.confirmText),
    ]),
  ]));
}
