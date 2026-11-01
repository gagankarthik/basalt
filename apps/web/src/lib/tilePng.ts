"use client";

/** Draws tiles onto one image from what's on screen: chart canvases as they are, everything else as its text. shortcut: a number tile's trend line isn't drawn, add it if readers miss it in exports. */
export async function tilesPng(tiles: HTMLElement[], name: string) {
  if (!tiles.length) return;
  const css = getComputedStyle(document.documentElement), v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
  const bg = v("--bg", "#fff"), ink = v("--ink", "#171a21"), line = v("--line", "#d8dde5"), font = v("--ui", "sans-serif");
  const rects = tiles.map((t) => t.getBoundingClientRect()), left = Math.min(...rects.map((r) => r.left)), top = Math.min(...rects.map((r) => r.top));
  const width = Math.max(...rects.map((r) => r.right)) - left, height = Math.max(...rects.map((r) => r.bottom)) - top, pad = 12, scale = 2;
  const cv = document.createElement("canvas");
  cv.width = (width + pad * 2) * scale; cv.height = (height + pad * 2) * scale;
  const c = cv.getContext("2d")!;
  c.scale(scale, scale); c.fillStyle = bg; c.fillRect(0, 0, width + pad * 2, height + pad * 2); c.textBaseline = "top";
  tiles.forEach((t, i) => {
    const r = rects[i], x = r.left - left + pad, y = r.top - top + pad;
    c.save(); c.beginPath(); c.rect(x, y, r.width, r.height); c.clip();
    c.strokeStyle = line; c.strokeRect(x + .5, y + .5, r.width - 1, r.height - 1);
    c.fillStyle = ink; c.font = `600 13px ${font}`; c.fillText(t.querySelector("h3")?.textContent ?? "", x + 10, y + 9);
    const charts = [...t.querySelectorAll("canvas")];
    for (const ch of charts) { const b = ch.getBoundingClientRect(); c.drawImage(ch, b.left - left + pad, b.top - top + pad, b.width, b.height); }
    if (!charts.length) {
      const big = t.querySelector(".kpi-v"), body = (t.querySelector<HTMLElement>(".tile-body")?.innerText ?? "").split("\n").map((l) => l.replace(/\t/g, "   ").trim()).filter(Boolean);
      let ly = y + 34;
      body.forEach((l, k) => { const large = big && k === 0; c.font = `${large ? 600 : 400} ${large ? 26 : 12}px ${font}`; c.fillText(l, x + 10, ly, r.width - 20); ly += large ? 34 : 17; });
    }
    c.restore();
  });
  const blob = await new Promise<Blob | null>((ok) => cv.toBlob(ok, "image/png"));
  if (!blob) throw new Error("The image couldn't be created.");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `${name}.png`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
