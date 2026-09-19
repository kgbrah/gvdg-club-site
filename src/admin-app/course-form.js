import React from "react";

const h = React.createElement;

const EMPTY_FORM = {
  location: "",
  name: "",
  udiscCourseId: "",
  udiscUrl: "",
};

function dispatchRequest(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function formField({ children, id, label }) {
  return h("div", { key: id }, [
    h("label", { htmlFor: id, key: "label" }, label),
    children,
  ]);
}

function coursePayload(form) {
  const name = form.name.trim();
  const location = form.location.trim();
  const udiscUrl = form.udiscUrl.trim();
  const udiscCourseId = form.udiscCourseId.trim();
  return {
    body: {
      location: location || null,
      name,
      udisc_course_id: udiscCourseId || null,
      udisc_url: udiscUrl || null,
    },
    labelText: name,
    valid: Boolean(name),
  };
}

export function AdminCourseForm() {
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [busy, setBusy] = React.useState(false);
  const [nearbyBusy, setNearbyBusy] = React.useState(false);
  const currentRequest = React.useRef("");
  const nearbyRequest = React.useRef("");
  const requestCounter = React.useRef(0);

  React.useEffect(() => {
    function update(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      if (!detail.requestId || detail.requestId !== currentRequest.current) return;
      setBusy(false);
      if (detail.ok === true) {
        setForm(EMPTY_FORM);
        currentRequest.current = "";
      }
    }
    function updateNearby(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : {};
      if (!detail.requestId || detail.requestId !== nearbyRequest.current) return;
      setNearbyBusy(false);
      nearbyRequest.current = "";
    }
    window.addEventListener("gvdg:admin-course-create-result", update);
    window.addEventListener("gvdg:admin-nearby-courses-import-result", updateNearby);
    return () => {
      window.removeEventListener("gvdg:admin-course-create-result", update);
      window.removeEventListener("gvdg:admin-nearby-courses-import-result", updateNearby);
    };
  }, []);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submit(event) {
    event.preventDefault();
    const payload = coursePayload(form);
    const requestId = `course-create-${requestCounter.current += 1}`;
    currentRequest.current = requestId;
    setBusy(true);
    dispatchRequest("gvdg:admin-course-create-request", { ...payload, requestId });
    if (!payload.valid) setBusy(false);
  }

  function importNearby() {
    const requestId = `nearby-courses-${requestCounter.current += 1}`;
    nearbyRequest.current = requestId;
    setNearbyBusy(true);
    dispatchRequest("gvdg:admin-nearby-courses-import-request", { requestId });
  }

  return h("div", { "data-react-admin-course-block": "ready" }, [
    h("form", {
      className: "admin-form",
      "data-react-admin-course-form": "ready",
      id: "adminCourseForm",
      key: "form",
      onSubmit: submit,
    }, [
      formField({
        id: "acName",
        label: "Course name",
        children: h("input", {
          id: "acName",
          key: "input",
          maxLength: 200,
          onChange: (event) => updateField("name", event.target.value),
          required: true,
          value: form.name,
        }),
      }),
      formField({
        id: "acLoc",
        label: "Location",
        children: h("input", {
          id: "acLoc",
          key: "input",
          maxLength: 200,
          onChange: (event) => updateField("location", event.target.value),
          value: form.location,
        }),
      }),
      formField({
        id: "acUdisc",
        label: "UDisc URL (https)",
        children: h("input", {
          id: "acUdisc",
          key: "input",
          maxLength: 1000,
          onChange: (event) => updateField("udiscUrl", event.target.value),
          type: "url",
          value: form.udiscUrl,
        }),
      }),
      formField({
        id: "acUdiscCourseId",
        label: "UDisc course id",
        children: h("input", {
          id: "acUdiscCourseId",
          inputMode: "numeric",
          key: "input",
          maxLength: 20,
          onChange: (event) => updateField("udiscCourseId", event.target.value),
          pattern: "\\d*",
          placeholder: "numeric id for Add to UDisc",
          value: form.udiscCourseId,
        }),
      }),
      h("button", { className: "admin-btn", disabled: busy, key: "submit", type: "submit" }, busy ? "Adding..." : "Add course"),
    ]),
    h("p", { className: "dash-note", key: "nearbyNote" }, "Import every listed course within 150 miles of Greenville. Existing club courses stay put. New ones get a par-3 default layout so a card can start right away."),
    h("button", {
      className: "admin-btn secondary",
      disabled: nearbyBusy,
      id: "nearbyCoursesImportBtn",
      key: "nearby",
      onClick: importNearby,
      type: "button",
    }, nearbyBusy ? "Importing nearby courses..." : "Import courses within 150 miles"),
  ]);
}
