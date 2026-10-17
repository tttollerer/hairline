import { isoBars, type IsoBarsData } from "./isobars";

const months = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const channels = ["Organic", "Paid", "Social"];

/** Deterministic demo data: a seasonal curve per channel, a little noise. */
function series(base: number[], season: number, seed: number): number[][] {
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  return base.map((b, c) => months.map((_, m) => {
    const wave = 1 + season * Math.sin(((m + c * 2) / 12) * Math.PI * 2 - 1.2);
    const trend = 1 + m * 0.035 * (c === 1 ? 1.6 : 1);
    return Math.round(b * wave * trend * (0.9 + rnd() * 0.2));
  }));
}

const metrics: Record<string, IsoBarsData> = {
  sessions: { columns: months, series: series([42000, 26000, 15000], 0.22, 7).map((values, i) => ({ name: channels[i], values })) },
  conversions: { columns: months, series: series([820, 1100, 260], 0.3, 11).map((values, i) => ({ name: channels[i], values })) },
  revenue: {
    columns: months,
    series: series([61000, 88000, 19000], 0.35, 23).map((values, i) => ({ name: channels[i], values })),
    format: (v) => (v >= 1000 ? `${(v / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} T€` : `${Math.round(v)} €`),
  },
};

const el = document.getElementById("chart")!;
const kpi = document.getElementById("kpi")!;
const total = (d: IsoBarsData) => d.series.reduce((a, s) => a + s.values.reduce((x, y) => x + y, 0), 0);
let current = "sessions";
const showTotal = () => {
  const d = metrics[current];
  kpi.textContent = `Gesamt ${d.format ? d.format(total(d)) : total(d).toLocaleString("de-DE")}`;
};

const chart = isoBars(el, {
  data: metrics[current],
  scrollTrack: document.getElementById("track"),
  label: "Traffic nach Kanal und Monat",
  onSelect: (sel) => {
    if (!sel) return showTotal();
    const d = metrics[current];
    kpi.textContent = `${d.series[sel.series].name} · ${sel.label}: ${d.format ? d.format(sel.value) : sel.value.toLocaleString("de-DE")}`;
  },
});
showTotal();

document.querySelectorAll<HTMLButtonElement>("[data-metric]").forEach((b) => b.addEventListener("click", () => {
  current = b.dataset.metric!;
  document.querySelectorAll("[data-metric]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  chart.update(metrics[current]);
  showTotal();
}));
document.getElementById("theme")!.addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
});
