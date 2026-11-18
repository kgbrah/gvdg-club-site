import React from "react";

import { currentAdminOrdersBadgeCount } from "./admin-shell-state.js";

const h = React.createElement;

const EMPTY_NEEDS = {
  status: "loading",
  bagRequests: 0,
  bagChallenges: 0,
  applications: 0,
  teeSigns: 0,
  marketReports: 0,
  lostFoundReports: 0,
  karmaFlags: 0,
};

const MORE_TABS = new Set(["bag-tags", "members", "tee-signs", "lost-found"]);

let adminNeedsState = EMPTY_NEEDS;

function countOf(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.round(count);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function currentAdminNeeds() {
  return adminNeedsState;
}

export function publishAdminNeeds(partial) {
  const source = partial && typeof partial === "object" ? partial : {};
  adminNeedsState = {
    status: "ready",
    bagRequests: countOf(source.bagRequests),
    bagChallenges: countOf(source.bagChallenges),
    applications: countOf(source.applications),
    teeSigns: countOf(source.teeSigns),
    marketReports: countOf(source.marketReports),
    lostFoundReports: countOf(source.lostFoundReports),
    karmaFlags: countOf(source.karmaFlags),
  };
  window.dispatchEvent(new CustomEvent("gvdg:admin-needs", { detail: adminNeedsState }));
  return adminNeedsState;
}

export function adminNeedsItems(source) {
  const input = source && typeof source === "object" ? source : {};
  const bagRequests = countOf(input.bagRequests);
  const bagChallenges = countOf(input.bagChallenges);
  const applications = countOf(input.applications);
  const teeSigns = countOf(input.teeSigns);
  const marketReports = countOf(input.marketReports);
  const lostFoundReports = countOf(input.lostFoundReports);
  const karmaFlags = countOf(input.karmaFlags);
  const orders = countOf(input.orders);
  const shelf = countOf(input.shelf);
  const shelfName = text(input.shelfName);
  const items = [];
  if (bagRequests) {
    items.push({
      id: "bag-requests",
      tab: "bag-tags",
      count: bagRequests,
      label: bagRequests === 1 ? "Bag tag request" : "Bag tag requests",
      detail: "Hand out the next number",
    });
  }
  if (bagChallenges) {
    items.push({
      id: "bag-challenges",
      tab: "bag-tags",
      count: bagChallenges,
      label: bagChallenges === 1 ? "Bag tag challenge" : "Bag tag challenges",
      detail: "Confirm the head-to-head",
    });
  }
  if (applications) {
    items.push({
      id: "applications",
      tab: "members",
      count: applications,
      label: applications === 1 ? "Member application" : "Member applications",
      detail: "Approve or decline",
    });
  }
  if (teeSigns) {
    items.push({
      id: "tee-signs",
      tab: "tee-signs",
      count: teeSigns,
      label: teeSigns === 1 ? "Tee sign to review" : "Tee signs to review",
      detail: "Awaiting review",
    });
  }
  if (marketReports) {
    items.push({
      id: "market-reports",
      tab: "marketplace",
      count: marketReports,
      label: marketReports === 1 ? "Marketplace report" : "Marketplace reports",
      detail: "Review and act",
    });
  }
  if (lostFoundReports) {
    items.push({
      id: "lost-found-reports",
      tab: "lost-found",
      count: lostFoundReports,
      label: lostFoundReports === 1 ? "Lost & Found report" : "Lost & Found reports",
      detail: "Review and act",
    });
  }
  if (karmaFlags) {
    items.push({
      id: "karma-flags",
      tab: "lost-found",
      count: karmaFlags,
      label: karmaFlags === 1 ? "Unusual karma" : "Unusual karma flags",
      detail: "More than 3 rounds in a day",
    });
  }
  if (orders) {
    items.push({
      id: "orders",
      tab: "orders",
      count: orders,
      label: orders === 1 ? "Shop order" : "Shop orders",
      detail: "Hand it off",
    });
  }
  if (shelf) {
    items.push({
      id: "shelf",
      tab: "shop",
      count: shelf,
      label: shelf === 1 && shelfName ? shelfName : "Low stock",
      detail: "Low on the shelf",
    });
  }
  return items;
}

export function adminNeedsBadgeCount(items, tab) {
  const rows = Array.isArray(items) ? items : [];
  if (tab === "today" || tab === "home") return rows.reduce((sum, item) => sum + item.count, 0);
  if (tab === "more") return rows.reduce((sum, item) => sum + (MORE_TABS.has(item.tab) ? item.count : 0), 0);
  return rows.reduce((sum, item) => sum + (item.tab === tab ? item.count : 0), 0);
}

export function useAdminNeeds() {
  const [queue, setQueue] = React.useState(currentAdminNeeds);
  const [orders, setOrders] = React.useState(currentAdminOrdersBadgeCount);
  const [shelf, setShelf] = React.useState(null);

  React.useEffect(() => {
    function updateQueue(event) {
      const detail = event.detail && typeof event.detail === "object" ? event.detail : currentAdminNeeds();
      setQueue(detail);
    }
    function updateOrders(event) {
      setOrders(countOf(event.detail && event.detail.count));
    }
    function updateShelf(event) {
      const count = Number(event.detail && event.detail.count);
      setShelf({
        count: Number.isFinite(count) && count > 0 ? Math.round(count) : 0,
        name: text(event.detail && event.detail.name),
      });
    }
    window.addEventListener("gvdg:admin-needs", updateQueue);
    window.addEventListener("gvdg:admin-orders-badge", updateOrders);
    window.addEventListener("gvdg:admin-shelf", updateShelf);
    setQueue(currentAdminNeeds());
    setOrders(currentAdminOrdersBadgeCount());
    return () => {
      window.removeEventListener("gvdg:admin-needs", updateQueue);
      window.removeEventListener("gvdg:admin-orders-badge", updateOrders);
      window.removeEventListener("gvdg:admin-shelf", updateShelf);
    };
  }, []);

  return {
    ready: queue.status === "ready" && shelf != null,
    items: adminNeedsItems({
      ...queue,
      orders,
      shelf: shelf ? shelf.count : 0,
      shelfName: shelf ? shelf.name : "",
    }),
  };
}

export function AdminNeedsBadge({ tab }) {
  const { items } = useAdminNeeds();
  const count = adminNeedsBadgeCount(items, tab);
  if (count <= 0) return null;
  return h("span", { className: "orders-badge" }, String(count));
}
