import React from "react";

const h = React.createElement;

export function AdminOrdersBadge() {
  const [count, setCount] = React.useState(() => Number(window.__gvdgAdminOrdersBadgeCount || 0));

  React.useEffect(() => {
    function update(event) {
      setCount(Number(event.detail?.count || 0));
    }
    window.addEventListener("gvdg:admin-orders-badge", update);
    setCount(Number(window.__gvdgAdminOrdersBadgeCount || 0));
    return () => window.removeEventListener("gvdg:admin-orders-badge", update);
  }, []);

  if (count <= 0) return null;
  return h("span", { className: "orders-badge" }, String(count));
}
