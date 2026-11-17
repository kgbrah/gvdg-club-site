import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium" });
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: "block", reducedMotion: "reduce" });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:5442/score.html?round=GVDG44&appearance=dark", { waitUntil: "commit" });
await page.locator(".score-glove-dock .stepper").first().waitFor(); await page.waitForTimeout(1200);
console.log(await page.evaluate(() => {
  const out=[]; const dock=document.querySelector(".score-glove-dock");
  const root=document.querySelector("#scoreRoot");
  const els=[...root.querySelectorAll(".topbar,.scorecard-weather,.score-glove-stage > *,.score-advanced,.score-advanced > *,.holegrid,.score-glove-dock,.score-glove-dock > *")];
  for (const el of els){const s=getComputedStyle(el),r=el.getBoundingClientRect(); out.push(el.tagName.toLowerCase()+"."+String(el.className).slice(0,40)+" | "+Math.round(r.x)+","+Math.round(r.y)+" "+Math.round(r.width)+"x"+Math.round(r.height)+" rad="+s.borderRadius+" pad="+s.padding+" ov="+s.overflowX+" bg="+s.backgroundColor.slice(0,30)+" bd="+s.borderTopWidth);}
  return out.join("\n");}));
await browser.close();
