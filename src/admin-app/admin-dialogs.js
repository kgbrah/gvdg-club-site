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
  return new Promise((resolve) => {
    queue.push({
      id: nextId++,
      resolve,
      title: options.title || "Confirm action",
      message: options.message || "",
      confirmText: options.confirmText || "Confirm",
      cancelText: options.cancelText || "Cancel",
      danger: options.danger === true,
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

export function AdminDialogs() {
  const [dialog, setDialog] = React.useState(activeDialog);
  const titleId = dialog ? `adminDialogTitle-${dialog.id}` : "adminDialogTitle";
  const bodyId = dialog ? `adminDialogBody-${dialog.id}` : "adminDialogBody";
  const a11y = useAccessibleDialog({
    open: Boolean(dialog),
    onClose: () => settle(false),
    labelledBy: titleId,
    label: dialog?.title || "Confirm action",
  });

  React.useEffect(() => {
    subscribers.add(setDialog);
    setDialog(activeDialog);
    return () => subscribers.delete(setDialog);
  }, []);

  if (!dialog) return null;
  const confirmClass = `admin-btn admin-dialog-btn${dialog.danger ? " danger-strong" : ""}`;

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
      h("p", { className: "admin-dialog-message", id: bodyId, key: "message" }, dialog.message),
      h("div", { className: "admin-dialog-actions", key: "actions" }, [
        h("button", { className: "admin-btn secondary admin-dialog-btn", key: "cancel", onClick: () => settle(false), type: "button" }, dialog.cancelText),
        h("button", { className: confirmClass, key: "confirm", onClick: () => settle(true), type: "button" }, dialog.confirmText),
      ]),
    ])),
    document.body,
  );
}
