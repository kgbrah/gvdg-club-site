export function holdDeskOrder(players, previousIds) {
  const list = Array.isArray(players) ? players : [];
  const previous = Array.isArray(previousIds) ? previousIds : [];
  const ids = list.map((player) => String(player && (player.id != null ? player.id : player.name) || ""));
  const samePeople = previous.length === ids.length && previous.every((id) => ids.includes(String(id)));
  if (!samePeople) return deskLine(list).map((player) => String(player && (player.id != null ? player.id : player.name) || ""));
  return previous;
}

export function deskLine(players) {
  const list = Array.isArray(players) ? players : [];
  const rank = (player) => (!player || player.paid ? 1 : 0) + (!player || player.checkedIn ? 1 : 0);
  return [...list].sort((left, right) => rank(left) - rank(right) || String(left?.name || "").localeCompare(String(right?.name || "")));
}

export function deskSummary(players) {
  const line = deskLine(players);
  const waiting = line.filter((player) => !player.checkedIn || !player.paid);
  return {
    here: line.filter((player) => player.checkedIn).length,
    owe: line.filter((player) => !player.paid).length,
    ready: line.length > 0 && waiting.length === 0,
    waiting: waiting.length,
    line,
  };
}

function orderItems(order) {
  const items = order && Array.isArray(order.items) ? order.items : [];
  return items.map((item) => ({
    name: item.name || item.name_snapshot || "Item",
    quantity: Number(item.quantity) > 0 ? Number(item.quantity) : 1,
  }));
}

export function counterHandoff(orders) {
  const open = (Array.isArray(orders) ? orders : []).map((order) => {
    const source = order && order.source ? order.source : order;
    if (!source) return null;
    const rawItems = Array.isArray(source.items) ? source.items : order.items;
    return {
      id: source.id,
      items: orderItems({ items: rawItems }),
      memberName: source.member_name || source.memberName || order.memberName || "",
      source,
      status: source.status || order.status || "",
    };
  }).filter((order) => order && ["ready", "submitted", "processing"].includes(order.status));
  return open.find((order) => order.status === "ready") || open[0] || null;
}

export function handoffLabel(order) {
  if (!order) return "";
  const who = order.memberName || "Order";
  const item = order.items && order.items[0];
  const what = item ? item.name : "item";
  const qty = item && item.quantity > 1 ? ` ×${item.quantity}` : "";
  return `${who}, ${what}${qty}`;
}

export function usualPriceDollars(products, name) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return "";
  const counts = new Map();
  for (const product of Array.isArray(products) ? products : []) {
    const productName = String(product?.name || "").trim().toLowerCase();
    const cents = product?.priceCents != null ? Number(product.priceCents) : Number(product?.price_cents);
    if (productName !== want || !Number.isFinite(cents)) continue;
    counts.set(cents, (counts.get(cents) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [cents, count] of counts) {
    if (count > bestCount) {
      best = cents;
      bestCount = count;
    }
  }
  if (best == null) return "";
  const abs = Math.abs(best);
  return abs % 100 ? (abs / 100).toFixed(2) : String(abs / 100);
}
