import React from "react";

const h = React.createElement;
const AUDIENCES = {
  card: "Card only",
  link: "Anyone with the watch link",
  public: "Anyone with the round code",
};

export function RoundSharing({ api, onCopyWatch }) {
  const id = React.useId();
  const [saved, setSaved] = React.useState(null);
  const [visibility, setVisibility] = React.useState("card");
  const [includeMarked, setIncludeMarked] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [request, setRequest] = React.useState(0);
  const apiRef = React.useRef(api);
  apiRef.current = api;
  React.useEffect(() => {
    let active = true;
    apiRef.current().then((result) => {
      if (!active) return;
      if (result.ok) {
        setSaved(result.data);
        setVisibility(result.data.visibility);
        setIncludeMarked(result.data.includeMarked);
        setNote("");
      } else setNote("Couldn’t load sharing settings. Try again when connected.");
    });
    return () => { active = false; };
  }, [request]);

  async function save() {
    setBusy(true);
    setNote("");
    const response = await api({ method: "PUT", body: { visibility, includeMarked } });
    if (response.ok) {
      setSaved(response.data);
      setNote(visibility === "link" ? "Watch link ready to copy." : "Watch sharing updated.");
    } else setNote("Couldn’t update watch sharing. Try again.");
    setBusy(false);
  }

  const changed = saved && (saved.visibility !== visibility || saved.includeMarked !== includeMarked);
  const canCopy = saved && !changed && (saved.visibility === "public" || saved.watchKey);
  return h("section", { className: "watch-sharing-form", "aria-label": "Watch link settings" },
    !saved ? h("p", { className: "muted", role: "status" }, note || "Checking round sharing…") : null,
    !saved && note ? h("button", { type: "button", className: "btn secondary", onClick: () => { setNote(""); setRequest((value) => value + 1); } }, "Retry sharing settings") : null,
    saved && !saved.owner ? h("p", { className: "muted" }, AUDIENCES[saved.visibility] + ". The round creator manages access.") : null,
    saved && saved.owner ? h(React.Fragment, null,
      h("label", { className: "lbl", htmlFor: id + "-audience" }, "Who can watch"),
      h("select", { className: "field", id: id + "-audience", value: visibility, disabled: busy, onChange: (event) => setVisibility(event.target.value) },
        Object.entries(AUDIENCES).map(([value, label]) => h("option", { key: value, value }, label))),
      h("p", { className: "muted" }, visibility === "card"
        ? "Only players on your card can see these scores. Use Invite to score to add a player."
        : visibility === "link"
          ? "Anyone who receives the watch link can see scores and shared clips. Making a new link disables the previous one."
          : "Anyone who knows this round’s code can watch scores and shared clips."),
      h("label", null,
        h("input", { type: "checkbox", checked: includeMarked, disabled: busy, onChange: (event) => setIncludeMarked(event.target.checked) }),
        " Include marked lies"),
      h("p", { className: "muted" }, "Viewers can see the positions players intentionally mark. Phone location and private shot details stay off the watch page."),
      h("div", { className: "watch-sharing-actions" },
        changed || visibility === "link" ? h("button", { type: "button", className: "btn secondary", disabled: busy, onClick: () => { void save(); } },
          busy ? "Saving…" : visibility === "link" ? (saved.watchKey ? "Replace watch link" : "Create watch link") : "Save watch sharing") : null,
        canCopy ? h("button", { type: "button", className: "btn", disabled: busy, onClick: () => { void onCopyWatch(saved.watchKey ?? null); } }, "Copy watch link") : null,
      ),
    ) : null,
    canCopy && !saved.owner ? h("button", { type: "button", className: "btn secondary", onClick: () => { void onCopyWatch(); } }, "Copy watch link") : null,
    saved && note ? h("p", { className: "muted", role: "status" }, note) : null,
  );
}

export function WatchSharingDetails(props) {
  const [open, setOpen] = React.useState(false);
  return h("details", { className: "watch-sharing", onToggle: (event) => setOpen(event.currentTarget.open) },
    h("summary", null, "Share watch link"),
    open ? h(RoundSharing, props) : null);
}
