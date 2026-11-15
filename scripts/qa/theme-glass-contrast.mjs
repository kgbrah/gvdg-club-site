// Shared by the theme glass QA scripts.
// Renders `scope` with its text hidden, then checks every text run's colour against the worst-case
// (95th percentile) background pixels beneath it. Returns failing runs (AA: 4.5, large text 3).
export async function measureContrast(page, scope, { top = 56, bottomInset = 64 } = {}) {
  const texts = await page.evaluate(({ scope, top, bottomInset }) => {
    const out = [];
    const walker = document.createTreeWalker(document.querySelector(scope), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const el = node.parentElement;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width < 4 || rect.height < 4 || rect.right > innerWidth || rect.left < 0 || rect.bottom < top || rect.top > innerHeight - bottomInset || style.visibility === "hidden" || Number(style.opacity) < 1 || !el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true, opacityProperty: true })) continue;
      // Skip runs that are clipped or covered (e.g. scrolled out of a strip): whatever is hit isn't the run.
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!hit || !(el.contains(hit) || hit.contains(el))) continue;
      out.push({ text: node.textContent.trim().slice(0, 24), x: rect.x, y: rect.y, w: rect.width, h: rect.height, color: style.color,
        size: parseFloat(style.fontSize), weight: Number(style.fontWeight) || 400 });
    }
    return out;
  }, { scope, top, bottomInset });
  await page.addStyleTag({ content: "*{color:transparent!important;text-shadow:none!important;caret-color:transparent!important}svg,img{opacity:0!important}" });
  const shot = (await page.screenshot({ animations: "disabled" })).toString("base64");
  return page.evaluate(async ({ shot, texts }) => {
    const image = new Image();
    image.src = "data:image/png;base64," + shot;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const fails = [];
    for (const t of texts) {
      const m = t.color.match(/[\d.]+/g).map(Number);
      if (t.color.startsWith("color(")) for (let i = 0; i < 3; i += 1) m[i] *= 255;
      const fg = m.length >= 4 && m[3] < 1 ? null : lum(m[0], m[1], m[2]);
      if (fg === null) continue;
      const w = Math.max(1, Math.min(Math.floor(t.w), canvas.width - Math.floor(t.x)));
      const h = Math.max(1, Math.min(Math.floor(t.h), canvas.height - Math.floor(t.y)));
      const data = ctx.getImageData(Math.max(0, Math.floor(t.x)), Math.max(0, Math.floor(t.y)), w, h).data;
      const ratios = [];
      for (let i = 0; i < data.length; i += 4) {
        const bg = lum(data[i], data[i + 1], data[i + 2]);
        ratios.push((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05));
      }
      ratios.sort((a, b) => a - b);
      const ratio = ratios[Math.floor(ratios.length * 0.05)] ?? 21;
      const large = t.size >= 24 || (t.size >= 18.66 && t.weight >= 700);
      if (ratio < (large ? 3 : 4.5)) fails.push(t.text + "|" + ratio.toFixed(2) + "|" + t.color + "|@" + Math.round(t.x) + "," + Math.round(t.y));
    }
    return fails;
  }, { shot, texts });
}
