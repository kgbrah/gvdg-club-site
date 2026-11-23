import React from "react";
import { Camera, ImagePlus } from "lucide-react";

import { applyShopVoice, VoiceFill } from "./voice-fill.js";
import { usualPriceDollars } from "./desk-model.js";
import { SHOP_BRANDS, SHOP_COLORS, SHOP_CUSTOM, choiceOptions, matchChoice, weightOptions } from "./shop-choices.js";
import { PHOTO_ACCEPT, useCameraCapture, useCameraMode } from "../public-app/photo-add.js";

const h = React.createElement;

const CATEGORY_OPTIONS = [
  ["disc", "Disc"],
  ["accessory", "Accessory"],
];

const TYPE_OPTIONS = [
  ["distance_driver", "Distance driver"],
  ["fairway_driver", "Fairway driver"],
  ["midrange", "Midrange"],
  ["putter", "Putter"],
  ["approach", "Approach"],
  ["bag", "Bag"],
  ["apparel", "Apparel"],
  ["accessory", "Accessory"],
];

const EMPTY_FORM = {
  brand: "",
  category: "disc",
  color: "",
  description: "",
  imageUrl: "",
  name: "",
  price: "",
  productType: "distance_driver",
  stock: "1",
  uploadedImageUrl: "",
  weight: "",
};

const hInput = "input";

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function dollarsToCents(value) {
  const numberValue = parseFloat(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) : null;
}

function positiveIntOrNull(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInt(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function resizeImageToDataUrl(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let width = img.width;
      let height = img.height;
      if (width > maxDim || height > maxDim) {
        if (width >= height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image_load_failed"));
    };
    img.src = url;
  });
}

function optionNodes(options) {
  return options.map(([value, label]) => h("option", { key: value, value }, label));
}

function ChoiceField({ extras, id, label, options, value, onChange, maxLength }) {
  const [customOn, setCustomOn] = React.useState(false);
  const known = choiceOptions(options, extras);
  const matched = matchChoice(value, known);
  const custom = customOn || (Boolean(value) && !matched);
  return h("div", null, [
    h("label", { htmlFor: id, key: "label" }, label),
    h("select", {
      id,
      key: "input",
      onChange: (event) => {
        const next = event.target.value;
        if (next === SHOP_CUSTOM) {
          setCustomOn(true);
          if (matched) onChange("");
          return;
        }
        setCustomOn(false);
        onChange(next);
      },
      value: custom ? SHOP_CUSTOM : matched,
    }, [
      h("option", { key: "blank", value: "" }, "Choose"),
      ...known.map((option) => h("option", { key: option, value: option }, option)),
      h("option", { key: "custom", value: SHOP_CUSTOM }, "Custom"),
    ]),
    custom ? h("input", {
      "aria-label": `Custom ${label}`,
      key: "custom",
      maxLength: maxLength || 80,
      onChange: (event) => onChange(event.target.value),
      placeholder: "Type it",
      value,
    }) : null,
  ]);
}

function fillBlankProductFields(form, fields) {
  const next = { ...form };
  const fresh = !String(form.name || "").trim();
  for (const key of ["name", "brand", "color", "weight", "price"]) {
    if (fields[key] && !String(form[key] || "").trim()) next[key] = String(fields[key]);
  }
  if (fields.productType && fresh) {
    next.productType = String(fields.productType);
    next.category = ["bag", "apparel", "accessory"].includes(fields.productType) ? "accessory" : "disc";
  }
  return next;
}

function formBody(form) {
  const price = dollarsToCents(form.price);
  return {
    body: {
      brand: form.brand.trim() || null,
      category: form.category,
      color: form.color.trim() || null,
      description: form.description.trim() || null,
      image_url: form.uploadedImageUrl || form.imageUrl.trim() || null,
      name: form.name.trim(),
      price_cents: price,
      product_type: form.productType || null,
      stock_qty: nonNegativeInt(form.stock),
      weight_g: positiveIntOrNull(form.weight),
    },
    valid: Boolean(form.name.trim() && price != null),
  };
}

export function AdminProductForm() {
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [busy, setBusy] = React.useState(false);
  const [readNote, setReadNote] = React.useState("");
  const fileRef = React.useRef(null);
  const requestCounter = React.useRef(0);
  const currentRequest = React.useRef("");
  const readRequest = React.useRef("");
  const catalogRef = React.useRef([]);
  const [shelf, setShelf] = React.useState({ brands: [], colors: [], weights: [] });

  React.useEffect(() => {
    function update(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      if (!detail.requestId || detail.requestId !== currentRequest.current) return;
      setBusy(false);
      if (detail.ok === true) {
        setForm(EMPTY_FORM);
        if (fileRef.current) fileRef.current.value = "";
        currentRequest.current = "";
        readRequest.current = "";
        setReadNote("");
      }
    }
    window.addEventListener("gvdg:admin-product-create-result", update);
    return () => window.removeEventListener("gvdg:admin-product-create-result", update);
  }, []);

  React.useEffect(() => {
    function repeat(event) {
      const product = event.detail && event.detail.product;
      if (!product) return;
      readRequest.current = "";
      setReadNote("");
      if (fileRef.current) fileRef.current.value = "";
      setForm({
        brand: product.brand || "",
        category: product.category || "disc",
        color: product.color || "",
        description: product.description || "",
        imageUrl: product.imageUrl || "",
        name: product.name || "",
        price: product.price || "",
        productType: product.productType || "distance_driver",
        stock: "1",
        uploadedImageUrl: "",
        weight: product.weight || "",
      });
      window.requestAnimationFrame(() => {
        const color = document.getElementById("psColor");
        color?.focus();
        color?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
    window.addEventListener("gvdg:admin-product-repeat", repeat);
    return () => window.removeEventListener("gvdg:admin-product-repeat", repeat);
  }, []);

  React.useEffect(() => {
    function filled(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      if (!detail.requestId || detail.requestId !== readRequest.current) return;
      const fields = detail.fields && typeof detail.fields === "object" ? detail.fields : null;
      if (!fields) {
        setReadNote("Couldn't read the stamp. Type the blanks.");
        return;
      }
      setForm((current) => {
        const next = fillBlankProductFields(current, fields);
        if (!next.price && next.name) {
          const price = usualPriceDollars(catalogRef.current, next.name);
          if (price) next.price = price;
        }
        return next;
      });
      setReadNote("Filled from the photo. Change anything that's wrong.");
    }
    window.addEventListener("gvdg:admin-product-read-result", filled);
    return () => window.removeEventListener("gvdg:admin-product-read-result", filled);
  }, []);

  React.useEffect(() => {
    function updateCatalog(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      if (detail.status === "loading") return;
      const products = Array.isArray(detail.products) ? detail.products : [];
      catalogRef.current = products;
      setShelf({
        brands: products.map((product) => product.brand),
        colors: products.map((product) => product.color),
        weights: products.map((product) => product.weight_g == null ? "" : String(product.weight_g)),
      });
      setForm((current) => {
        if (current.price || !current.name) return current;
        const price = usualPriceDollars(products, current.name);
        return price ? { ...current, price } : current;
      });
    }
    window.addEventListener("gvdg:admin-products-list", updateCatalog);
    return () => window.removeEventListener("gvdg:admin-products-list", updateCatalog);
  }, []);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  const handlePhotoFile = React.useCallback(async (file) => {
    if (!file) return;
    try {
      const dataUrl = await resizeImageToDataUrl(file, 700, 0.78);
      setForm((current) => ({ ...current, imageUrl: "", uploadedImageUrl: dataUrl }));
      const requestId = `product-read-${requestCounter.current += 1}`;
      readRequest.current = requestId;
      setReadNote("Reading the stamp…");
      dispatchRequest("gvdg:admin-product-read-request", { image: dataUrl, requestId });
      dispatchRequest("gvdg:admin-product-photo-ready", { sizeKb: Math.round(dataUrl.length / 1024) });
    } catch {
      dispatchRequest("gvdg:admin-product-photo-error", {});
    }
  }, []);

  const handleCameraFiles = React.useCallback((files) => {
    const file = Array.isArray(files) ? files[0] : null;
    if (file) void handlePhotoFile(file);
  }, [handlePhotoFile]);

  const chooseFile = React.useCallback(() => {
    fileRef.current?.click();
  }, []);

  const cameraMode = useCameraMode();
  const hasCamera = cameraMode === "live" || cameraMode === "app";
  const [startCamera, cameraSheet] = useCameraCapture({
    chooseFiles: chooseFile,
    hint: "Center the disc stamp in the frame.",
    max: 1,
    mode: cameraMode,
    onFiles: handleCameraFiles,
  });

  function updateFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (file) void handlePhotoFile(file);
  }

  function clearUploadedPhoto() {
    readRequest.current = "";
    setReadNote("");
    setForm((current) => ({ ...current, uploadedImageUrl: "" }));
    if (fileRef.current) fileRef.current.value = "";
  }

  function updateImageUrl(value) {
    if (value) {
      readRequest.current = "";
      setReadNote("");
    }
    setForm((current) => ({ ...current, imageUrl: value, uploadedImageUrl: value ? "" : current.uploadedImageUrl }));
    if (value && fileRef.current) fileRef.current.value = "";
  }

  function submit(event) {
    event.preventDefault();
    if (busy) return;
    const payload = formBody(form);
    const requestId = `product-create-${requestCounter.current += 1}`;
    currentRequest.current = requestId;
    setBusy(true);
    dispatchRequest("gvdg:admin-product-create-request", { ...payload, requestId });
    if (!payload.valid) setBusy(false);
  }

  return h("form", {
    className: "admin-form admin-surface",
    "data-react-admin-product-form": "ready",
    id: "adminProductForm",
    onSubmit: submit,
  }, [
    h(VoiceFill, {
      form: "shop",
      key: "voice",
      onFields: (fields) => setForm((current) => applyShopVoice(current, fields)),
    }),
    h("div", { key: "category" }, [
      h("label", { htmlFor: "psCategory", key: "label" }, "Category"),
      h("select", { id: "psCategory", key: "input", onChange: (event) => updateField("category", event.target.value), value: form.category }, optionNodes(CATEGORY_OPTIONS)),
    ]),
    h("div", { key: "name" }, [
      h("label", { htmlFor: "psName", key: "label" }, "Product name"),
      h(hInput, { id: "psName", key: "input", maxLength: 160, onBlur: () => setForm((current) => {
        if (current.price || !current.name) return current;
        const price = usualPriceDollars(catalogRef.current, current.name);
        return price ? { ...current, price } : current;
      }), onChange: (event) => updateField("name", event.target.value), required: true, value: form.name }),
    ]),
    h(ChoiceField, {
      extras: shelf.brands,
      id: "psBrand",
      key: "brand",
      label: "Brand",
      maxLength: 80,
      onChange: (value) => updateField("brand", value),
      options: SHOP_BRANDS,
      value: form.brand,
    }),
    h("div", { key: "type" }, [
      h("label", { htmlFor: "psType", key: "label" }, "Type"),
      h("select", { id: "psType", key: "input", onChange: (event) => updateField("productType", event.target.value), value: form.productType }, optionNodes(TYPE_OPTIONS)),
    ]),
    h(ChoiceField, {
      extras: shelf.colors,
      id: "psColor",
      key: "color",
      label: "Color",
      maxLength: 60,
      onChange: (value) => updateField("color", value),
      options: SHOP_COLORS,
      value: form.color,
    }),
    h(ChoiceField, {
      extras: shelf.weights,
      id: "psWeight",
      key: "weight",
      label: "Weight (g)",
      maxLength: 6,
      onChange: (value) => updateField("weight", value.replace(/[^\d]/g, "")),
      options: weightOptions(shelf.weights),
      value: form.weight,
    }),
    h("div", { key: "price" }, [
      h("label", { htmlFor: "psPrice", key: "label" }, "Price ($)"),
      h(hInput, { id: "psPrice", key: "input", min: "0", onChange: (event) => updateField("price", event.target.value), required: true, step: "0.01", type: "number", value: form.price }),
    ]),
    h("div", { key: "stock" }, [
      h("label", { htmlFor: "psStock", key: "label" }, "Stock"),
      h(hInput, { id: "psStock", key: "input", min: "0", onChange: (event) => updateField("stock", event.target.value), step: "1", type: "number", value: form.stock }),
    ]),
    h("div", { className: "admin-product-form-wide", key: "image" }, [
      h("label", { htmlFor: "psImage", key: "label" }, "Image"),
      h(hInput, { id: "psImage", key: "url", maxLength: 2000, onChange: (event) => updateImageUrl(event.target.value), placeholder: "https://… paste an image URL", type: "url", value: form.imageUrl }),
      h("div", { className: "admin-product-image-input", "data-photo-camera": cameraMode, key: "file-row" }, [
        h(hInput, { accept: PHOTO_ACCEPT, "aria-label": "Upload product photo", className: "admin-sr-only", id: "psImageFile", key: "file", onChange: updateFile, ref: fileRef, type: "file" }),
        h("div", { className: "admin-product-photo-actions", key: "actions" }, [
          hasCamera ? h("button", {
            className: "admin-btn secondary admin-product-photo-btn",
            disabled: busy,
            key: "camera",
            onClick: startCamera,
            type: "button",
          }, [
            h(Camera, { "aria-hidden": true, key: "icon", size: 18 }),
            form.uploadedImageUrl ? "Retake photo" : "Take photo",
          ]) : null,
          h("button", {
            className: "admin-btn secondary admin-product-photo-btn",
            disabled: busy,
            key: "choose",
            onClick: chooseFile,
            type: "button",
          }, [
            h(ImagePlus, { "aria-hidden": true, key: "icon", size: 18 }),
            hasCamera ? "Choose photo" : "Upload photo",
          ]),
        ]),
        h("span", { className: "al-note", key: "note" }, hasCamera
          ? "Take a photo to auto-read the disc stamp, or pick one from your device."
          : "Upload a photo to auto-read the disc stamp from your device."),
      ]),
      form.uploadedImageUrl ? h("figure", {
        className: "admin-product-image-preview",
        "data-react-admin-product-image-preview": "ready",
        key: "preview",
      }, [
        h("img", {
          alt: "Selected product preview",
          className: "shop-admin-thumb admin-product-image-preview-img",
          key: "image",
          src: form.uploadedImageUrl,
        }),
        h("div", { className: "admin-product-image-preview-body", key: "body" }, [
          h("figcaption", { className: "admin-product-image-preview-note", key: "caption" }, readNote || "Selected photo will be saved when you add the product."),
          h("button", {
            className: "admin-btn secondary",
            disabled: busy,
            key: "remove",
            onClick: clearUploadedPhoto,
            type: "button",
          }, "Remove photo"),
        ]),
      ]) : null,
      cameraSheet,
    ]),
    h("div", { className: "admin-product-form-wide", key: "description" }, [
      h("label", { htmlFor: "psDescription", key: "label" }, "Description"),
      h("textarea", { id: "psDescription", key: "input", maxLength: 1000, onChange: (event) => updateField("description", event.target.value), rows: 3, value: form.description }),
    ]),
    h("button", { className: "admin-btn", disabled: busy, key: "submit", type: "submit" }, busy ? "Adding…" : "Add product"),
  ]);
}
