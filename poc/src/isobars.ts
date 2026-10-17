import { Cam, clamp, facing, fit, hull, lerp, poly, prism, proj, ringAt, rings, seg, type Camera, type Projector, type Ring, type Vec2, type Vec3 } from "../../packages/hairline/src/core/iso";
import { spring, stepS, type Spring } from "../../packages/hairline/src/core/motion";
import { disposer, mk, register } from "../../packages/hairline/src/core/stage";

/**
 * isoBars — a data-driven isometric column chart on the Hairline engine.
 *
 * Proof of concept for four layers the package does not have: data in, scroll
 * as an input, an HTML overlay for words, and series colours. Everything that
 * moves still runs in the package's one frame loop, on its springs.
 *
 * Grid: columns (x) × series (y). Heights are springs; their targets come from
 * the data, the scroll progress (growth) and a per-bar stagger on data change.
 */

export type Series = { name: string; values: number[] };
export type IsoBarsData = { columns: string[]; series: Series[]; format?: (v: number) => string };
export type Selection = { column: number; series: number; value: number; label: string } | null;
export type IsoBarsOptions = {
  data: IsoBarsData;
  /** A tall element around a sticky chart: its scroll progress grows the bars, then turns the camera. */
  scrollTrack?: HTMLElement | null;
  onSelect?: (sel: Selection) => void;
  label?: string;
};
export type IsoBars = { update(data: IsoBarsData): void; destroy(): void };

const VW = 600, VH = 440;                 // our own viewBox: wider than the package's 400 × 320
const PX = 9, PY = 10, W = 5.6, X0 = 6, Y0 = 6, H = 40, WALL = H + 4, BZ = 3, S = 4;
const AZ_REST = 45, AZ_END = 38, PARALLAX = 9;  // degrees
const K_REST = 0.5, K_END = 0.72;        // sin(elevation): the scroll's second half lifts the camera, so the far row comes clear
const GROW_END = 0.45;                   // share of the scroll track that grows the bars
const STAGGER = 32;                      // ms per diagonal step on a data change
const TICKS = [0.25, 0.5, 0.75, 1];

const niceCeil = (v: number) => {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((n) => f <= n) ?? 10) * e;
};
const inside = (p: Vec2, poly: Vec2[]) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
const ease = (t: number) => 1 - Math.pow(1 - t, 3);
/** Data strings go into innerHTML: escape them, the data may come from anywhere. */
const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Bar = {
  i: number; j: number; cx: number; cy: number; diag: number;
  ring: Ring; inner: Ring; g: SVGGElement; sil: SVGPathElement; top: SVGPathElement; cr: SVGPathElement;
  sp: Spring; value: number; norm: number; pendingAt: number; pendingNorm: number; drawn: number;
};

export function isoBars(el: HTMLElement, options: IsoBarsOptions): IsoBars {
  const bag = disposer();
  let data = options.data;
  const NX = data.columns.length, NY = data.series.length;
  const LX = 2 * X0 + (NX - 1) * PX, LY = 2 * Y0 + (NY - 1) * PY;
  const raw = (v: number) => (data.format ? data.format(v) : Math.round(v).toLocaleString("de-DE"));
  const fmt = (v: number) => esc(raw(v));

  /* ---------- DOM: svg, overlay, a table for screen readers ---------- */
  el.classList.add("isobars");
  el.tabIndex = 0;
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", options.label ?? "Säulendiagramm, Pfeiltasten wählen einen Wert");
  const svg = mk("svg", { viewBox: `0 0 ${VW} ${VH}`, "aria-hidden": "true" });
  const overlay = document.createElement("div");
  overlay.className = "isobars-overlay";
  overlay.setAttribute("aria-hidden", "true");
  const tip = document.createElement("div");
  tip.className = "isobars-tip";
  const live = document.createElement("div");
  live.className = "isobars-sr";
  live.setAttribute("aria-live", "polite");
  const table = document.createElement("table");
  table.className = "isobars-sr";
  el.append(svg, overlay, live, table);
  overlay.append(tip);
  bag.add(() => { svg.remove(); overlay.remove(); live.remove(); table.remove(); el.classList.remove("isobars"); });

  const mkLabel = (cls: string, text: string) => {
    const s = document.createElement("span");
    s.className = cls; s.textContent = text; overlay.append(s); return s;
  };
  const colLabels = data.columns.map((c, i) => mkLabel(`isobars-col${i % 2 ? " odd" : ""}`, c));
  const serLabels = data.series.map((s, j) => mkLabel(`isobars-ser s${j}`, s.name));
  const tickLabels = TICKS.map(() => mkLabel("isobars-tick", ""));

  /* ---------- camera ---------- */
  const C: Camera = Cam(AZ_REST, 0.5, S);
  const extent: Vec3[] = [[0, 0, -BZ], [LX, 0, -BZ], [0, LY, -BZ], [LX, LY, -BZ], [0, 0, WALL], [LX, 0, WALL], [0, LY, WALL]];
  let P: Projector = proj(C), front = facing(C);
  const setCamera = (azDeg: number, k: number) => {
    C.az = (azDeg * Math.PI) / 180;
    C.k = k;
    fit(C, extent, VW / 2, VH / 2 + 8);
    P = proj(C); front = facing(C);
  };
  setCamera(AZ_REST, K_REST);

  /* ---------- the scene, back to front: walls, floor, bars ---------- */
  const back = mk("g", {}, svg);
  const wallX = mk("path", {}, back), wallY = mk("path", {}, back);
  const grid = mk("path", { class: "nf lo" }, back);
  const mark = mk("path", { class: "nf hi mark" }, back);
  const floorG = mk("g", {}, svg);
  const floorSil = mk("path", { class: "sil" }, floorG), floorCr = mk("path", { class: "nf lo" }, floorG);
  const [fo, fi] = rings(-2, -2, LX + 2, LY + 2, 4, 1.4);
  const barsG = mk("g", {}, svg);

  const bars: Bar[] = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const cx = X0 + i * PX, cy = Y0 + j * PY;
    const [ring, inner] = rings(cx - W / 2, cy - W / 2, cx + W / 2, cy + W / 2, 1.1, 0.5);
    const g = mk("g", { class: `bar s${j}` }, barsG);
    const sil = mk("path", { class: "sil" }, g), top = mk("path", { class: "top fo" }, g), cr = mk("path", { class: "nf lo" }, g);
    bars.push({ i, j, cx, cy, diag: (i + j * 2) / (NX - 1 + (NY - 1) * 2), ring, inner, g, sil, top, cr,
      sp: spring(0, { k: 90, c: 17, eps: 0.02 }), value: 0, norm: 0, pendingAt: 0, pendingNorm: 0, drawn: NaN });
  }

  /* ---------- data ---------- */
  let scaleMax = 1;
  function applyData(next: IsoBarsData, stagger: boolean) {
    data = next;
    const max = Math.max(...next.series.flatMap((s) => s.values));
    scaleMax = niceCeil(max);
    const now = performance.now();
    for (const b of bars) {
      b.value = next.series[b.j]?.values[b.i] ?? 0;
      b.pendingNorm = b.value / scaleMax;
      b.pendingAt = stagger ? now + b.diag * (NX + NY) * STAGGER : now;
    }
    TICKS.forEach((f, k) => { tickLabels[k].textContent = raw(scaleMax * f); });
    next.series.forEach((s, j) => { serLabels[j].textContent = s.name; });
    table.innerHTML = `<caption>${esc(options.label ?? "Daten")}</caption><tr><th></th>${next.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>` +
      next.series.map((s) => `<tr><th>${esc(s.name)}</th>${s.values.map((v) => `<td>${fmt(v)}</td>`).join("")}</tr>`).join("");
    if (selected) select(selected, true);
    loop.wake();
  }

  /* ---------- inputs: scroll, parallax ---------- */
  let progress = options.scrollTrack ? 0 : 1;
  const readScroll = () => {
    const t = options.scrollTrack;
    if (!t) return;
    const r = t.getBoundingClientRect(), span = r.height - window.innerHeight;
    const p = span > 0 ? clamp(-r.top / span, 0, 1) : 1;
    if (p !== progress) { progress = p; loop.wake(); }
  };
  const tilt = spring(0, { k: 60, c: 14, eps: 0.01 });
  let camDrawn = NaN;

  /* ---------- the frame ---------- */
  let order = "";
  function frame(dt: number, now: number): boolean {
    let moving = stepS(tilt, dt);
    const grow = clamp(progress / GROW_END, 0, 1);
    const turn = ease(clamp((progress - GROW_END) / (1 - GROW_END), 0, 1));
    const az = lerp(AZ_REST, AZ_END, turn) + tilt.x;
    const k = lerp(K_REST, K_END, turn), camKey = az * 10 + k;
    const camMoved = camKey !== camDrawn;
    if (camMoved) { setCamera(az, k); camDrawn = camKey; drawStatic(); }

    for (const b of bars) {
      if (now >= b.pendingAt && b.norm !== b.pendingNorm) b.norm = b.pendingNorm;
      if (b.pendingAt > now) moving = true;
      const g = ease(clamp(grow * 1.6 - b.diag * 0.6, 0, 1));
      b.sp.t = b.norm * H * g;
      moving = stepS(b.sp, dt) || moving;
      const h = Math.max(0.6, b.sp.x);
      if (h === b.drawn && !camMoved) continue;
      b.drawn = h;
      const s = prism(P, front, b.ring, b.inner, 0, h);
      b.sil.setAttribute("d", s.sil);
      b.cr.setAttribute("d", s.crease);
      b.top.setAttribute("d", poly(ringAt(P, b.ring, h)));
    }
    if (camMoved) sortBars();
    if (selected) placeTip();
    return moving;
  }

  function drawStatic() {
    const wx = [P(0, 0, 0), P(LX + 2, 0, 0), P(LX + 2, 0, WALL), P(0, 0, WALL)];
    const wy = [P(0, 0, 0), P(0, LY + 2, 0), P(0, LY + 2, WALL), P(0, 0, WALL)];
    wallX.setAttribute("d", poly(wx));
    wallY.setAttribute("d", poly(wy));
    grid.setAttribute("d", TICKS.map((f) => seg(P(0, 0, H * f), P(LX + 2, 0, H * f)) + seg(P(0, 0, H * f), P(0, LY + 2, H * f))).join(""));
    const fl = prism(P, front, fo, fi, -BZ, 0);
    floorSil.setAttribute("d", fl.sil);
    floorCr.setAttribute("d", fl.crease);
    const at = (s: HTMLElement, q: Vec2) => { s.style.left = `${(q[0] / VW) * 100}%`; s.style.top = `${(q[1] / VH) * 100}%`; };
    colLabels.forEach((s, i) => at(s, P(X0 + i * PX, LY + 5, -BZ)));
    serLabels.forEach((s, j) => at(s, P(LX + 5, Y0 + j * PY, -BZ)));
    tickLabels.forEach((s, k) => at(s, P(0, LY + 3, H * TICKS[k])));
  }

  /** Painter's order for the camera as it is: far bars first. */
  function sortBars() {
    const sa = Math.sin(C.az), ca = Math.cos(C.az);
    const sorted = bars.slice().sort((a, b) => a.cx * sa + a.cy * ca - (b.cx * sa + b.cy * ca));
    const key = sorted.map((b) => b.i + "," + b.j).join(";");
    if (key === order) return;
    order = key;
    for (const b of sorted) barsG.appendChild(b.g);
  }

  /* ---------- selection ---------- */
  let selected: Bar | null = null;
  function select(b: Bar | null, force = false) {
    if (b === selected && !force) return;
    selected = b;
    el.classList.toggle("has-sel", !!b);
    for (const x of bars) {
      x.g.classList.toggle("on", x === b);
      x.sil.classList.toggle("hi", x === b);
    }
    if (!b) {
      tip.classList.remove("show");
      mark.setAttribute("d", "");
      options.onSelect?.(null);
      return;
    }
    const prev = b.i > 0 ? data.series[b.j].values[b.i - 1] : NaN;
    const delta = Number.isFinite(prev) && prev ? ((b.value - prev) / prev) * 100 : NaN;
    tip.innerHTML = `<b>${fmt(b.value)}</b><span>${esc(data.series[b.j].name)} · ${esc(data.columns[b.i])}</span>` +
      (Number.isFinite(delta) ? `<em class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(1)} %</em>` : "");
    tip.classList.add("show");
    live.textContent = `${data.series[b.j].name}, ${data.columns[b.i]}: ${raw(b.value)}`;
    options.onSelect?.({ column: b.i, series: b.j, value: b.value, label: data.columns[b.i] });
    placeTip();
  }
  function placeTip() {
    if (!selected) return;
    const b = selected, h = b.norm * H;
    const q = P(b.cx, b.cy, Math.max(0.6, b.sp.x));
    tip.style.left = `${(q[0] / VW) * 100}%`;
    tip.style.top = `${(q[1] / VH) * 100}%`;
    // the value, marked on both walls at its target height: drawn behind every bar
    mark.setAttribute("d", seg(P(0, 0, h), P(LX + 2, 0, h)) + seg(P(0, 0, h), P(0, LY + 2, h)));
  }

  /** Hit test against each bar's TARGET silhouette (rule 01), nearest bar first. */
  function pick(p: Vec2): Bar | null {
    const sa = Math.sin(C.az), ca = Math.cos(C.az);
    let best: Bar | null = null, depth = -Infinity;
    for (const b of bars) {
      const h = Math.max(0.6, b.sp.t);
      const d = b.cx * sa + b.cy * ca;
      if (d < depth) continue;
      if (inside(p, hull(ringAt(P, b.ring, 0).concat(ringAt(P, b.ring, h))))) { best = b; depth = d; }
    }
    return best;
  }

  const toView = (e: PointerEvent): Vec2 => {
    const r = svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * VW, ((e.clientY - r.top) / r.height) * VH];
  };
  bag.on(el, "pointermove", (e) => {
    const p = toView(e);
    tilt.t = clamp((p[0] / VW - 0.5) * 2, -1, 1) * PARALLAX;
    select(pick(p));
    loop.wake();
  });
  bag.on(el, "pointerleave", () => { tilt.t = 0; select(null); loop.wake(); });
  bag.on(el, "keydown", (e) => {
    const k = e.key;
    if (k === "Escape") { select(null); return; }
    const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (!dir[k]) return;
    e.preventDefault();
    const cur = selected ?? bars.reduce((a, b) => (b.value > a.value ? b : a));
    const ni = selected ? clamp(cur.i + dir[k][0], 0, NX - 1) : cur.i, nj = selected ? clamp(cur.j + dir[k][1], 0, NY - 1) : cur.j;
    select(bars.find((b) => b.i === ni && b.j === nj) ?? null);
    loop.wake();
  });
  bag.on(el, "blur", () => select(null));

  const loop = register(el, frame);
  bag.add(loop.unregister);
  if (options.scrollTrack) {
    const onScroll = () => readScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    bag.add(() => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); });
    readScroll();
  }
  applyData(data, false);
  bag.add(() => svg.replaceChildren());

  return { update: (d) => applyData(d, true), destroy: bag.dispose };
}
