import React from "react";

import { adminConfirm } from "./admin-dialogs.js";
import { useSettledWhileLoading } from "../shared/settled-state.js";

const h = React.createElement;

const EMPTY_STATE = { status: "loading", products: [], inventoryStatus: "active" };

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeProduct(product) {
  const source = objectOrEmpty(product);
  const name = normalizeText(source.name, "Product") || "Product";
  return {
    source,
    active: Number(source.active) === 1 || source.active === true,
    brand: normalizeText(source.brand),
    category: normalizeText(source.category, "disc") || "disc",
    color: normalizeText(source.color),
    description: normalizeText(source.description),
    id: source.id == null ? "" : String(source.id),
    imageUrl: normalizeText(source.image_url),
    name,
    priceCents: source.price_cents == null ? null : normalizeNumber(source.price_cents, 0),
    productType: normalizeText(source.product_type),
    stockQty: normalizeNumber(source.stock_qty, 0),
    weightG: source.weight_g == null ? null : normalizeNumber(source.weight_g, 0),
  };
}

function normalizeState(state) {
  return {
    inventoryStatus: normalizeText(state.inventoryStatus, "active") || "active",
    products: Array.isArray(state.products) ? state.products.map(normalizeProduct) : [],
    status: state.status === "loading" ? "loading" : "ready",
  };
}

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function dollarsFromCents(cents) {
  const n = Number(cents || 0);
  const abs = Math.abs(n);
  const out = "$" + (abs / 100).toLocaleString(undefined, { minimumFractionDigits: abs % 100 ? 2 : 0 });
  return n < 0 ? "-" + out : out;
}

function priceInputValue(cents) {
  if (cents == null) return "";
  return String(Number(cents) / 100);
}

function ProductThumb({ product }) {
  if (product.imageUrl) {
    return h("img", {
      alt: product.name || "Product image",
      className: "shop-admin-thumb",
      loading: "lazy",
      src: product.imageUrl,
    });
  }

  const fallback = (product.brand || product.name || "?").slice(0, 1).toUpperCase();
  return h("div", { className: "shop-admin-thumb fallback", "aria-label": `${product.name} image placeholder`, role: "img" }, fallback);
}

function ProductRow({ product }) {
  const [priceValue, setPriceValue] = React.useState(() => priceInputValue(product.priceCents));
  const [stockValue, setStockValue] = React.useState(() => String(product.stockQty || 0));
  const [active, setActive] = React.useState(() => product.active);
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);

  React.useEffect(() => {
    setPriceValue(priceInputValue(product.priceCents));
    setStockValue(String(product.stockQty || 0));
    setActive(product.active);
  }, [product.id, product.priceCents, product.stockQty, product.active]);

  function requestAnother() {
    dispatchRequest("gvdg:admin-product-repeat", {
      product: {
        brand: product.brand,
        category: product.category,
        color: product.color,
        description: product.description,
        imageUrl: product.imageUrl,
        name: product.name,
        price: priceInputValue(product.priceCents),
        productType: product.productType,
        weight: product.weightG != null ? String(product.weightG) : "",
      },
    });
  }

  function sellOne() {
    const current = Number(stockValue);
    if (!Number.isFinite(current) || current < 1) return;
    const next = current - 1;
    setStockValue(String(next));
    dispatchRequest("gvdg:admin-product-save-request", {
      active: product.active,
      priceValue: priceInputValue(product.priceCents),
      product: product.source,
      stockValue: String(next),
    });
  }
  function requestSave() {
    dispatchRequest("gvdg:admin-product-save-request", {
      active,
      priceValue,
      product: product.source,
      stockValue,
    });
  }

  async function requestDelete() {
    const confirmed = await adminConfirm({
      title: "Delete product",
      message: `Permanently delete "${product.name || "this product"}"? Past orders keep the item name, price, and quantity, but this product will be removed from inventory.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    dispatchRequest("gvdg:admin-product-delete-request", { product: product.source });
  }

  return h("div", { className: `shop-tile-card${editing ? " editing" : ""}${active ? "" : " inactive"}`, "data-admin-product-id": product.id }, [
    h("button", {
      className: open ? "shop-tile on" : "shop-tile",
      key: "tile",
      onClick: () => {
        setOpen((current) => !current);
        setEditing(false);
      },
      type: "button",
    }, [
      h(ProductThumb, { key: "thumb", product }),
      h("span", { className: "ev-name", key: "name" }, product.name),
      h("span", { className: "shop-admin-meta", key: "meta" }, [
        product.priceCents != null ? dollarsFromCents(product.priceCents) : "No price",
        ` · ${product.stockQty || 0} left`,
        product.color ? ` · ${product.color}` : "",
      ].join("")),
    ]),
    open && !editing ? h("div", { className: "shop-tile-actions", key: "actions" }, [
      h("button", { className: "admin-btn", disabled: Number(stockValue) < 1, key: "sold", onClick: sellOne, type: "button" }, Number(stockValue) < 1 ? "Sold out" : "Sold"),
      h("button", { className: "admin-btn secondary", key: "another", onClick: requestAnother, type: "button" }, "Add another"),
      h("button", { className: "admin-btn secondary", key: "edit", onClick: () => setEditing(true), type: "button" }, "Edit"),
    ]) : null,
    editing ? h("div", { className: "shop-admin-controls", key: "controls" }, [
      h("input", {
        "aria-label": `Price for ${product.name}`,
        key: "price",
        min: "0",
        onChange: (event) => setPriceValue(event.target.value),
        step: "0.01",
        type: "number",
        value: priceValue,
      }),
      h("input", {
        "aria-label": `Stock for ${product.name}`,
        key: "stock",
        min: "0",
        onChange: (event) => setStockValue(event.target.value),
        step: "1",
        type: "number",
        value: stockValue,
      }),
      h("label", { className: "register-addon", key: "active" }, [
        h("input", {
          checked: active,
          key: "checkbox",
          onChange: (event) => setActive(event.target.checked),
          type: "checkbox",
        }),
        active ? " active" : " archived",
      ]),
      h("button", { className: "admin-btn secondary", key: "save", onClick: requestSave, type: "button" }, "Save"),
      h("button", { className: "admin-btn danger", key: "delete", onClick: requestDelete, type: "button" }, "Delete"),
    ]) : null,
  ]);
}

export function AdminProductsList() {
  const [state, setState] = React.useState(() => normalizeState(EMPTY_STATE));

  React.useEffect(() => {
    function update(event) {
      setState(normalizeState(event.detail && typeof event.detail === "object" ? event.detail : EMPTY_STATE));
    }
    window.addEventListener("gvdg:admin-products-list", update);
    return () => window.removeEventListener("gvdg:admin-products-list", update);
  }, []);

  const view = useSettledWhileLoading(state, state.inventoryStatus);

  if (view.status === "loading") {
    return h("p", { className: "al-note", "data-react-admin-products-list": "loading", role: "status" }, "Loading...");
  }

  if (!view.products.length) {
    return h("p", { className: "al-note", "data-react-admin-products-list": "empty", role: "status" }, view.inventoryStatus === "inactive" ? "No archived products." : "No products yet.");
  }

  return h("div", { className: "shop-admin-list shop-counter", "data-react-admin-products-list": "ready" }, view.products.map((product, index) => (
    h(ProductRow, {
      key: product.id || `${product.name}-${index}`,
      product,
    })
  )));
}
