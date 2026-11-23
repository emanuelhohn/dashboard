/* Wirtschaftsdaten Schweiz – Dashboard
   Liest data/data.json (Schweiz, Märkte) und data/intl.json (Ländervergleich),
   die täglich vom Skript scripts/fetch_data.py erzeugt werden. */
"use strict";

// ======================================================================
// Grundlagen
// ======================================================================
const NOW = new Date();
const YEAR = NOW.getFullYear();
const DAY = 864e5;
const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const MONTHS_LONG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
// Spätestens so viele Tage nach Ende der Periode sollte ein neuer Wert da sein.
const MAX_LAG = { D: 10, M: 80, Q: 170, A: 640 };
// Ausnahmen: Reihen, die regulär später publiziert werden
const MAX_LAG_SERIES = { "Kurzarbeitende": 175 };
const MAX_FETCH_AGE_H = 54; // Update läuft täglich; > 2 Tage = Update ausgefallen

// Daten: Auf GitHub Pages liegen sie neben der Seite. Lokal (Vorschau, Doppelklick)
// werden die aktuellen Daten direkt von der veröffentlichten Seite geholt.
const DATA_BASE = location.hostname.endsWith("github.io") ? "" : "https://emanuelhohn.github.io/dashboard/";

let CH = null;    // data.json
let INTL = null;  // intl.json
let intlPromise = null;
const charts = new Map();

const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(k));
  return el;
};
const appendAll = (el, ...kids) => { for (const k of kids.flat()) if (k != null && k !== false) el.append(k); return el; };
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const SERIES_VARS = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];

const nf = (d = 1) => new Intl.NumberFormat("de-CH", { minimumFractionDigits: d, maximumFractionDigits: d });
function fmt(v, d = 1) { return v == null || isNaN(v) ? "–" : nf(d).format(v); }
function fmtSigned(v, d = 1) { if (v == null) return "–"; const r = +v.toFixed(d); return (r > 0 ? "+" : r < 0 ? "−" : "±") + nf(d).format(Math.abs(r)); }
function fmtBig(v, unit) {
  if (v == null) return "–";
  const a = Math.abs(v);
  if (unit === "Mio. CHF") return a >= 1e6 ? fmt(v / 1e6, 2) + " Bio." : a >= 1e3 ? fmt(v / 1e3, 1) + " Mrd." : fmt(v, 0) + " Mio.";
  if (unit === "t CO₂" && a >= 1e6) return fmt(v / 1e6, 1) + " Mio.";
  if (a >= 1e4) return fmt(v, 0);
  if (a >= 100) return fmt(v, 1);
  return fmt(v, 2);
}

// ---------- Datumslogik ----------
// Datum als Kommazahl (Jahr + Bruchteil): einfache, lineare x-Achse
function toX(d) {
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d))) return +m[1] + (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(+m[1], 0, 1)) / (365.25 * DAY);
  if ((m = /^(\d{4})-(\d{2})$/.exec(d))) return +m[1] + (+m[2] - 1) / 12;
  if ((m = /^(\d{4})-Q(\d)$/.exec(d))) return +m[1] + (+m[2] - 1) / 4;
  if ((m = /^(\d{4})$/.exec(d))) return +m[1];
  return NaN;
}
function periodEnd(d) {
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d))) return new Date(+m[1], +m[2] - 1, +m[3]);
  if ((m = /^(\d{4})-(\d{2})$/.exec(d))) return new Date(+m[1], +m[2], 0);
  if ((m = /^(\d{4})-Q(\d)$/.exec(d))) return new Date(+m[1], +m[2] * 3, 0);
  if ((m = /^(\d{4})$/.exec(d))) return new Date(+m[1], 11, 31);
  return null;
}
function fmtPeriod(d, long = false) {
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d))) return `${+m[3]}.${+m[2]}.${m[1]}`;
  if ((m = /^(\d{4})-(\d{2})$/.exec(d))) return `${(long ? MONTHS_LONG : MONTHS)[+m[2] - 1]} ${m[1]}`;
  if ((m = /^(\d{4})-Q(\d)$/.exec(d))) return long ? `${m[2]}. Quartal ${m[1]}` : `Q${m[2]} ${m[1]}`;
  return d;
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("de-CH", { day: "numeric", month: "long", year: "numeric" }) + ", " +
    d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" }) + " Uhr";
}
function xLabel(x, span) {
  const y = Math.floor(x + 1e-6);
  if (span > 3) return String(y);
  const mo = Math.round((x - y) * 12);
  return `${MONTHS[Math.min(mo, 11)]} ${String(y).slice(2)}`;
}

// ---------- Aktualität ----------
function status(obj, { lastDate = null, hasForecast = false } = {}) {
  if (!obj) return { level: "crit", text: "Keine Daten", long: "Diese Datenreihe konnte nie geladen werden." };
  const last = lastDate || (obj.data && obj.data.length ? obj.data[obj.data.length - 1][0] : null);
  if (obj.error) return { level: "crit", text: "Abruf fehlgeschlagen", long: `Letzter Abruf fehlgeschlagen – angezeigt werden ältere Daten (Stand ${fmtPeriod(last || "")}).` };
  const fetchedAgeH = (NOW - new Date(obj.fetched)) / 36e5;
  if (fetchedAgeH > MAX_FETCH_AGE_H) return { level: "crit", age: true, text: "Nicht aktualisiert", long: `Seit ${Math.round(fetchedAgeH / 24)} Tagen nicht mehr abgerufen.` };
  if (!last) return { level: "crit", text: "Keine Werte", long: "Keine Werte vorhanden." };
  if (!hasForecast) {
    const lag = (NOW - periodEnd(last)) / DAY;
    if (lag > (MAX_LAG_SERIES[obj.title] || MAX_LAG[obj.freq])) return { level: "warn", text: "Veraltet", long: `Letzter Wert: ${fmtPeriod(last, true)}. Ein neuerer Wert wäre zu erwarten. Die Quelle publiziert diese Reihe evtl. nicht mehr.` };
  }
  return { level: "ok", text: "Aktuell", long: `Letzter Wert: ${fmtPeriod(last, true)}, abgerufen ${fmtDateTime(obj.fetched)}.` };
}
// Kleiner Ampelpunkt bei einer Zahl – nur wenn genau diese Reihe ein Problem hat.
// (Fällt das ganze Update aus, zeigt das die Ampel in der Kopfzeile.)
function hasOwnProblem(st) { return st && st.level !== "ok" && !st.age; }
function smallDot(st) { return hasOwnProblem(st) ? h("i", { class: `dot sm ${st.level}`, title: st.long }) : null; }

// ---------- Reihen ----------
const S = (id) => CH.series[id];
function pts(id) { const s = S(id); return s ? s.data.map(([d, v]) => ({ x: toX(d), y: v, d })) : []; }
function last(id) { const s = S(id); return s && s.data.length ? s.data[s.data.length - 1] : null; }

// Abgeleitete Reihen
function derived(id) {
  if (id === "gdp_yoy") { // reales BIP ggü. Vorjahresquartal
    const d = S("gdp_level").data;
    return d.slice(4).map(([p, v], i) => [p, (v / d[i][1] - 1) * 100]);
  }
  if (id === "cpi_yoy_long") { // Inflation ab 1922 aus dem Index
    const d = S("cpi_index").data;
    const map = new Map(d);
    return d.filter(([p]) => map.has(`${+p.slice(0, 4) - 1}${p.slice(4)}`))
      .map(([p, v]) => [p, (v / map.get(`${+p.slice(0, 4) - 1}${p.slice(4)}`) - 1) * 100]);
  }
  return null;
}
function seriesData(id) { return derived(id) || (S(id) ? S(id).data : []); }

// Jahreswerte aus unterjährigen Daten
function annual(data, how = "mean") {
  const by = new Map();
  for (const [p, v] of data) { const y = p.slice(0, 4); if (!by.has(y)) by.set(y, []); by.get(y).push(v); }
  const out = new Map();
  for (const [y, arr] of by) out.set(y, { v: how === "last" ? arr[arr.length - 1] : how === "sum" ? arr.reduce((a, b) => a + b, 0) : arr.reduce((a, b) => a + b, 0) / arr.length, n: arr.length });
  return out;
}

// ======================================================================
// Diagramme (Chart.js)
// ======================================================================
function baseOptions({ unit, dec = 1, span, xmin, xmax, isBar = false, yZero = false }) {
  const grid = css("--grid"), muted = css("--muted"), text2 = css("--text-2");
  return {
    responsive: true, maintainAspectRatio: false, animation: false, parsing: false, normalized: true,
    interaction: { mode: "nearest", axis: "x", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: css("--surface"), titleColor: css("--text"), bodyColor: text2, borderColor: css("--border"), borderWidth: 1,
        padding: 10, boxPadding: 4, usePointStyle: true,
        callbacks: {
          title: (items) => items.length ? fmtPeriod(items[0].raw.d, true) + (items[0].raw.f ? " (Prognose)" : "") : "",
          label: (it) => ` ${it.dataset.label}: ${fmt(it.raw.y, dec)} ${unit}`,
        },
      },
      decimation: { enabled: true, algorithm: "min-max" },
    },
    scales: {
      x: {
        type: "linear", min: xmin, max: xmax, offset: isBar,
        grid: { display: false }, border: { color: grid },
        ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback: (v) => xLabel(v, span) },
      },
      y: {
        beginAtZero: yZero, grid: { color: (c) => (c.tick.value === 0 ? muted : grid), lineWidth: (c) => (c.tick.value === 0 ? 1.2 : 1) },
        border: { display: false },
        ticks: { color: muted, callback: (v) => fmt(v, Math.abs(v) >= 1000 ? 0 : (dec > 2 ? 2 : (Number.isInteger(v) ? 0 : 1))) },
      },
    },
  };
}

function lineDataset(label, points, color, { dashedForecast = false, width = 2, fill = false } = {}) {
  return {
    label, data: points, borderColor: color, backgroundColor: color, borderWidth: width,
    pointRadius: 0, pointHoverRadius: 4, pointHoverBorderWidth: 2, pointHoverBorderColor: css("--surface"),
    tension: 0, spanGaps: false, fill,
    segment: dashedForecast ? { borderDash: (ctx) => (ctx.p1.raw.f ? [4, 4] : undefined) } : undefined,
  };
}

function drawChart(canvas, { type = "line", datasets, unit, dec, xmin, xmax, yZero }) {
  const old = charts.get(canvas);
  if (old) old.destroy();
  const all = datasets.flatMap((d) => d.data);
  const lo = xmin ?? Math.min(...all.map((p) => p.x)), hi = xmax ?? Math.max(...all.map((p) => p.x));
  const opts = baseOptions({ unit, dec, span: hi - lo, xmin: lo, xmax: hi, isBar: type === "bar", yZero });
  if (type === "bar") {
    opts.interaction = { mode: "nearest", axis: "x", intersect: false };
    for (const ds of datasets) {
      ds.borderRadius = 2; ds.borderSkipped = false; ds.barPercentage = 0.92; ds.categoryPercentage = 1;
      ds.backgroundColor = ds.data.map((p) => (p.y < 0 ? css("--s2") : css("--s1")));
      ds.borderWidth = 0;
    }
    opts.plugins.decimation.enabled = false;
  }
  const chart = new Chart(canvas, { type, data: { datasets }, options: opts });
  charts.set(canvas, chart);
  return chart;
}

function legendEl(items) {
  return h("div", { class: "legend" }, items.map((it) =>
    h("span", {}, h("i", { class: it.dash ? "dash" : "", style: `background:${it.color};color:${it.color}` }), it.label)));
}

function toCSV(rows) {
  return rows.map((r) => r.map((c) => (typeof c === "number" ? String(c) : `"${String(c ?? "").replace(/"/g, '""')}"`)).join(";")).join("\n");
}
function download(name, text) {
  const a = h("a", { href: URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" })), download: name });
  document.body.append(a); a.click(); a.remove();
}

// ---------- Panel mit Zeitraumwahl, Tabelle, CSV ----------
const RANGES = { "1J": 1, "5J": 5, "10J": 10, "25J": 25, "50J": 50, "100J": 100, "Max": Infinity };

/**
 * cfg: { title, sub, series:[{id|data, label}], unit, dec, type, ranges, range, explain, yZero, tall }
 */
function panel(cfg) {
  const lines = cfg.series.map((s) => ({ ...s, data: s.data || seriesData(s.id), meta: s.meta || (s.id && S(s.id)) || {} }));
  const unit = cfg.unit || lines[0].meta.unit || "";
  const dec = cfg.dec ?? 1;
  const ranges = cfg.ranges || ["1J", "5J", "10J", "25J", "Max"];
  let range = cfg.range || "10J";
  let showTable = false;

  const canvas = h("canvas", { role: "img", "aria-label": cfg.title });
  const box = h("div", { class: "chart-box" + (cfg.tall ? " tall" : "") }, canvas);
  const tableBox = h("div", { class: "tablebox", hidden: true });
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Zeitraum" });
  const el = h("section", { class: "panel", id: cfg.anchor || null });

  const sts = lines.map((l) => status(l.meta, { lastDate: l.data.length ? l.data[l.data.length - 1][0] : null }));
  const worst = sts.find((s) => s.level === "crit") || sts.find((s) => s.level === "warn") || sts[0];
  const fc = lines[0].meta.forecastFrom || null; // ab diesem Jahr Prognose
  let lastPeriod = lines[0].data.length ? lines[0].data[lines[0].data.length - 1][0] : null;
  const standText = fc && lastPeriod && +lastPeriod >= fc ? ` · Ist-Werte bis ${fc - 1}, gestrichelt: Prognose bis ${lastPeriod}` : (lastPeriod ? ` · Stand ${fmtPeriod(lastPeriod, true)}` : "");

  function render() {
    const maxX = Math.max(...lines.map((l) => (l.data.length ? toX(l.data[l.data.length - 1][0]) : -Infinity)));
    const minX = RANGES[range] === Infinity ? null : maxX - RANGES[range];
    const datasets = lines.map((l, i) => lineDataset(l.label,
      l.data.map(([d, y]) => ({ x: toX(d), y, d, f: !!(fc && +d.slice(0, 4) >= fc) })).filter((p) => minX == null || p.x >= minX - 1e-9),
      css(SERIES_VARS[l.color ?? i]), { width: cfg.width || 2, dashedForecast: !!fc }));
    drawChart(canvas, { type: cfg.type || "line", datasets, unit, dec, xmin: minX ?? undefined, yZero: cfg.yZero });
    for (const b of seg.children) b.classList.toggle("on", b.dataset.r === range);
    if (showTable) renderTable(minX);
  }
  function renderTable(minX) {
    const dates = [...new Set(lines.flatMap((l) => l.data.map((r) => r[0])))].sort().reverse()
      .filter((d) => minX == null || toX(d) >= minX - 1e-9);
    const maps = lines.map((l) => new Map(l.data));
    tableBox.replaceChildren(h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Periode"), lines.map((l) => h("th", {}, l.label)))),
      h("tbody", {}, dates.slice(0, 600).map((d) => h("tr", {}, h("td", {}, fmtPeriod(d)), maps.map((m) => h("td", { class: "num" }, fmt(m.get(d), dec))))))));
  }
  for (const r of ranges) seg.append(h("button", { type: "button", "data-r": r, onclick: () => { range = r; render(); } }, r === "Max" ? "Alles" : r.replace("J", " J.")));

  const tblBtn = h("button", { class: "btn", type: "button", onclick: () => { showTable = !showTable; tableBox.hidden = !showTable; tblBtn.textContent = showTable ? "Diagramm" : "Tabelle"; box.hidden = showTable; render(); } }, "Tabelle");
  const csvBtn = h("button", { class: "btn", type: "button", title: "Als CSV für Excel herunterladen", onclick: () => {
    const dates = [...new Set(lines.flatMap((l) => l.data.map((r) => r[0])))].sort();
    const maps = lines.map((l) => new Map(l.data));
    download(`${(cfg.file || cfg.title).replace(/[^\wäöüÄÖÜ-]+/g, "_")}.csv`,
      toCSV([["Periode", ...lines.map((l) => `${l.label} (${unit})`)], ...dates.map((d) => [d, ...maps.map((m) => m.get(d) ?? "")])]));
  } }, "CSV");

  appendAll(el,
    h("div", { class: "panel-head" },
      h("div", {}, h("h3", {}, cfg.title), h("div", { class: "sub" }, (cfg.sub ? cfg.sub + " · " : "") + unit + standText, smallDot(worst)))),
    h("div", { class: "panel-tools" }, seg, h("div", { class: "tools-right" }, tblBtn, csvBtn)),
    lines.length > 1 ? legendEl(lines.map((l, i) => ({ label: l.label, color: css(SERIES_VARS[l.color ?? i]) }))) : null,
    box, tableBox,
    cfg.explain ? h("p", { class: "explain", html: cfg.explain }) : null,
  );
  el._render = render;
  el._setRange = (r) => { if (ranges.includes(r)) { range = r; render(); } };
  el._ranges = ranges;
  queueMicrotask(render);
  return el;
}

// ======================================================================
// Seiten
// ======================================================================
const PAGES = [
  { id: "ueberblick", label: "Überblick" },
  { id: "wachstum", label: "Wachstum" },
  { id: "preise", label: "Preise" },
  { id: "geld", label: "Geld & Zinsen" },
  { id: "maerkte", label: "Finanzmärkte" },
  { id: "arbeit", label: "Arbeit" },
  { id: "umwelt", label: "Umwelt" },
  { id: "welt", label: "Ländervergleich" },
  { id: "ranking", label: "Ranking" },
  { id: "quellen", label: "Quellen" },
];

function pageHead(title, text, actions = []) {
  return h("div", { class: "page-head" }, h("div", {}, h("h1", {}, title), text ? h("p", {}, text) : null), actions.length ? h("div", { class: "actions" }, actions) : null);
}
function longViewBtn(container, r = "Max", label = "Lange Sicht: alles") {
  return h("button", { class: "btn", type: "button", onclick: () => container.querySelectorAll(".panel").forEach((p) => p._setRange && p._setRange(p._ranges.includes(r) ? r : "Max")) }, label);
}
function compareBtn(indicator, label = "International vergleichen") {
  return h("a", { class: "btn primary", href: `#welt?i=${indicator}`, style: "text-decoration:none" }, label + " →");
}

// ---------- Überblick ----------
function tileEl({ cat, page, label, value, unit, dec = 1, period, delta, spark, st }) {
  return h("a", { class: "tile", href: "#" + page },
    h("div", { class: "cat" }, cat),
    h("div", { class: "label" }, label),
    h("div", { class: "value num" }, value == null ? "–" : fmt(value, dec), unit ? h("small", {}, unit) : null),
    h("div", { class: "meta" }, period || "", smallDot(st)),
    delta ? h("div", { class: "delta" }, delta) : null,
    spark ? sparkSVG(spark) : null);
}
function sparkSVG(data) {
  const W = 200, H = 34;
  if (data.length < 2) return null;
  const xs = data.map((d) => toX(d[0])), ys = data.map((d) => d[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = (x) => ((x - x0) / (x1 - x0 || 1)) * W, sy = (y) => H - 2 - ((y - y0) / (y1 - y0 || 1)) * (H - 4);
  const step = Math.max(1, Math.floor(data.length / 120));
  const d = data.filter((_, i) => i % step === 0 || i === data.length - 1).map((p, i) => `${i ? "L" : "M"}${sx(toX(p[0])).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = (y0 < 0 && y1 > 0 ? `<line class="zero" x1="0" x2="${W}" y1="${sy(0)}" y2="${sy(0)}"/>` : "") + `<path d="${d}" vector-effect="non-scaling-stroke"/>`;
  return svg;
}
function sinceYears(data, years) { if (!data.length) return data; const lx = toX(data[data.length - 1][0]); return data.filter((r) => toX(r[0]) >= lx - years); }
function valueAgo(data, days) {
  const end = periodEnd(data[data.length - 1][0]).getTime() - days * DAY;
  for (let i = data.length - 1; i >= 0; i--) if (periodEnd(data[i][0]).getTime() <= end) return data[i];
  return null;
}

function tileFor(def) {
  const data = seriesData(def.id);
  const s = S(def.id) || S(def.base);
  if (!data.length) return tileEl({ ...def, value: null, st: status(null) });
  const [p, v] = data[data.length - 1];
  let delta = null;
  if (def.delta === "pp") {
    const prev = data[data.length - 2];
    const word = { M: "Vormonat", Q: "Vorquartal", D: "Vortag" }[s.freq] || "Vorperiode";
    if (prev) delta = `${fmtSigned(v - prev[1], def.dec ?? 1)} Pp. ggü. ${word}`;
  } else if (def.delta === "pct1y") {
    const ago = valueAgo(data, 365);
    if (ago) delta = `${fmtSigned((v / ago[1] - 1) * 100, 1)} % in 12 Monaten`;
  } else if (def.delta === "pct1m") {
    const ago = valueAgo(data, 30);
    if (ago) delta = `${fmtSigned((v / ago[1] - 1) * 100, 1)} % in 1 Monat`;
  }
  return tileEl({ ...def, value: v, period: fmtPeriod(p, true), delta, spark: sinceYears(data, 5), st: status(s, { lastDate: p }) });
}

const TILES = [
  { cat: "Preise", page: "preise", id: "cpi_yoy", label: "Inflation (Teuerung LIK)", unit: "%", dec: 1, delta: "pp" },
  { cat: "Wachstum", page: "wachstum", id: "gdp_qoq", label: "BIP-Wachstum real, ggü. Vorquartal", unit: "%", dec: 1, delta: "pp" },
  { cat: "Wachstum", page: "wachstum", id: "gdp_yoy", base: "gdp_level", label: "BIP-Wachstum real, ggü. Vorjahresquartal", unit: "%", dec: 1, delta: "pp" },
  { cat: "Arbeit", page: "arbeit", id: "unemp_sa", label: "Arbeitslosenquote (saisonbereinigt)", unit: "%", dec: 1, delta: "pp" },
  { cat: "Geld", page: "geld", id: "policy_rate", label: "SNB-Leitzins", unit: "%", dec: 2 },
  { cat: "Geld", page: "geld", id: "m3_yoy", label: "Geldmenge M3, ggü. Vorjahr", unit: "%", dec: 1, delta: "pp" },
  { cat: "Finanzmärkte", page: "maerkte", id: "smi_d", label: "SMI (Aktienindex)", unit: "Pkt.", dec: 0, delta: "pct1y" },
  { cat: "Finanzmärkte", page: "maerkte", id: "eurchf_d", label: "Euro in Franken", unit: "CHF", dec: 4, delta: "pct1y" },
  { cat: "Finanzmärkte", page: "maerkte", id: "usdchf_d", label: "US-Dollar in Franken", unit: "CHF", dec: 4, delta: "pct1y" },
];

function intlValue(key, iso, year) {
  const ds = INTL && INTL.datasets[key];
  const arr = ds && ds.countries[iso];
  if (!arr) return null;
  const row = year ? arr.find((r) => r[0] === String(year)) : arr[arr.length - 1];
  return row ? { y: row[0], v: row[1], ds } : null;
}

function renderOverview(root) {
  appendAll(root, pageHead("Die Schweizer Wirtschaft auf einen Blick",
    "Die wichtigsten Kennzahlen mit dem jeweils neusten Wert. Ein Klick auf eine Kachel öffnet die Details mit langen Zeitreihen und dem internationalen Vergleich."));
  const tiles = h("div", { class: "tiles" }, TILES.map(tileFor));
  root.append(tiles);

  // Kacheln mit internationalen Daten (laden nach)
  const intlTiles = [
    { cat: "Wachstum", page: "ranking", key: "imf_NGDPDPC", label: "BIP pro Kopf (nominal)", unit: "USD", dec: 0, year: YEAR - 1 },
    { cat: "Umwelt", page: "umwelt", key: "co2_pc", label: "CO₂-Emissionen pro Kopf", unit: "t", dec: 1 },
  ];
  const placeholders = intlTiles.map((t) => { const el = tileEl({ ...t, value: null, period: "wird geladen …" }); tiles.append(el); return el; });
  loadIntl().then(() => intlTiles.forEach((t, i) => {
    const r = intlValue(t.key, "CHE", t.year);
    if (!r) return;
    let delta = null;
    if (t.key === "imf_NGDPDPC") {
      const all = Object.entries(r.ds.countries).map(([iso, a]) => [iso, (a.find((x) => x[0] === r.y) || [])[1]]).filter((x) => x[1] != null).sort((a, b) => b[1] - a[1]);
      delta = `Rang ${all.findIndex((x) => x[0] === "CHE") + 1} von ${all.length} Ländern`;
    } else {
      const w = intlValue(t.key, "WLD", r.y);
      if (w) delta = `Weltdurchschnitt: ${fmt(w.v, 1)} t`;
    }
    const arr = r.ds.countries.CHE.filter((x) => +x[0] <= +r.y && +x[0] > +r.y - 15);
    placeholders[i].replaceWith(tileEl({ ...t, value: r.v, period: r.y + (+r.y >= YEAR ? " (Schätzung IWF)" : ""), delta, spark: arr, st: status(r.ds, { lastDate: r.y, hasForecast: t.key.startsWith("imf") }) }));
  })).catch(() => placeholders.forEach((p) => p.replaceWith(tileEl({ cat: "International", page: "welt", label: "Internationale Daten", value: null, period: "konnten nicht geladen werden" }))));

  // Mehrjahresvergleich
  root.append(h("h2", { class: "section-title" }, "Mehrjahresvergleich (Jahreswerte)"));
  root.append(yearTable());
  root.append(h("p", { class: "note" }, "Inflation, Arbeitslosenquote, Wechselkurs: Jahresdurchschnitt. BIP-Wachstum: reales BIP des Jahres ggü. Vorjahr. Leitzins: Stand Jahresende. Laufendes Jahr: bisher verfügbare Monate."));
}

function yearTable() {
  const years = []; for (let y = YEAR - 6; y <= YEAR; y++) years.push(String(y));
  const cpi = annual(S("cpi_index").data);
  const gdp = annual(S("gdp_level").data, "sum");
  const rows = [
    ["Inflation (LIK)", "%", (y) => { const a = cpi.get(y), b = cpi.get(String(+y - 1)); return a && b ? { v: (a.v / b.v - 1) * 100, partial: a.n < 12 ? `${a.n} Mt.` : null } : null; }, 1],
    ["Reales BIP-Wachstum", "%", (y) => { const a = gdp.get(y), b = gdp.get(String(+y - 1)); return a && b && a.n === 4 ? { v: (a.v / b.v - 1) * 100 } : null; }, 1],
    ["Arbeitslosenquote", "%", (y) => { const a = annual(S("unemp").data).get(y); return a ? { v: a.v, partial: a.n < 12 ? `${a.n} Mt.` : null } : null; }, 1],
    ["SNB-Leitzins (Ende Jahr)", "%", (y) => { const a = annual(S("policy_rate").data, "last").get(y); return a ? { v: a.v, partial: y === String(YEAR) ? "aktuell" : null } : null; }, 2],
    ["EUR/CHF (Durchschnitt)", "CHF", (y) => { const a = annual(S("eurchf_m").data).get(y); return a ? { v: a.v, partial: a.n < 12 ? `${a.n} Mt.` : null } : null; }, 3],
    ["USD/CHF (Durchschnitt)", "CHF", (y) => { const a = annual(S("usdchf_m").data).get(y); return a ? { v: a.v, partial: a.n < 12 ? `${a.n} Mt.` : null } : null; }, 3],
  ];
  return h("div", { class: "yeartable" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "Kennzahl"), years.map((y) => h("th", {}, y === String(YEAR) ? `${y}*` : y)))),
    h("tbody", {}, rows.map(([label, unit, fn, dec]) => h("tr", {}, h("td", {}, `${label} (${unit})`),
      years.map((y) => { const r = fn(y); return h("td", { class: "num" }, r ? fmt(r.v, dec) : "–", r && r.partial ? h("span", { class: "partial" }, r.partial) : null); }))))));
}

// ---------- Kategorieseiten ----------
function renderWachstum(root) {
  const grid = h("div", { class: "grid" });
  appendAll(root, pageHead("Wachstum", "Das Bruttoinlandprodukt (BIP) misst den Wert aller in der Schweiz hergestellten Waren und Dienstleistungen. Real heisst: um die Teuerung bereinigt.",
    [longViewBtn(grid, "Max", "Seit 1980"), compareBtn("imf_NGDP_RPCH"), h("a", { class: "btn", href: "#ranking", style: "text-decoration:none" }, "Ranking BIP pro Kopf")]), grid);
  grid.append(
    panel({ title: "Reales BIP-Wachstum gegenüber Vorquartal", series: [{ id: "gdp_qoq", label: "BIP" }], type: "bar", unit: "%", range: "10J", ranges: ["5J", "10J", "25J", "Max"],
      explain: "Saison- und sportevent-bereinigt. Zwei negative Quartale in Folge gelten umgangssprachlich als <b>technische Rezession</b>." }),
    panel({ title: "Reales BIP-Wachstum gegenüber Vorjahresquartal", series: [{ id: "gdp_yoy", label: "BIP", meta: S("gdp_level") }], unit: "%", range: "25J", ranges: ["5J", "10J", "25J", "Max"], yZero: true }),
    panel({ title: "Reales BIP pro Quartal", series: [{ id: "gdp_level", label: "BIP" }], unit: "Mio. CHF", dec: 0, range: "Max", ranges: ["10J", "25J", "Max"],
      explain: "Gut sichtbar: Finanzkrise 2008/09, Frankenschock 2015 und Corona-Einbruch 2020." }),
    panel({ title: "Verwendung: Konsum, Investitionen, Exporte", sub: "ggü. Vorquartal", series: [{ id: "cons_qoq", label: "Privater Konsum" }, { id: "inv_qoq", label: "Investitionen" }, { id: "exp_qoq", label: "Exporte" }], unit: "%", range: "5J", ranges: ["1J", "5J", "10J", "Max"] }),
  );
  loadIntl().then(() => {
    grid.append(intlPanel({ title: "Reales BIP-Wachstum pro Jahr inkl. Prognose", key: "imf_NGDP_RPCH", countries: ["CHE"], range: "25J" }));
    grid.append(intlPanel({ title: "BIP pro Kopf der Schweiz", key: "imf_NGDPDPC", countries: ["CHE"], range: "Max", dec: 0 }));
  });
}

function renderPreise(root) {
  const grid = h("div", { class: "grid" });
  appendAll(root, pageHead("Preise & Inflation",
    "Der Landesindex der Konsumentenpreise (LIK) misst die Preisentwicklung eines typischen Warenkorbs. Die Inflation (Teuerung) ist die prozentuale Veränderung gegenüber dem Vorjahresmonat.",
    [longViewBtn(grid, "100J", "Die letzten 100 Jahre"), compareBtn("infl_m")]), grid);
  grid.append(
    panel({ title: "Inflation Schweiz", sub: "ggü. Vorjahresmonat", series: [{ id: "cpi_yoy_long", label: "Inflation", meta: S("cpi_index") }], unit: "%", range: "10J", ranges: ["1J", "5J", "10J", "25J", "50J", "100J"], tall: true, yZero: true,
      explain: "Die SNB strebt Preisstabilität an: eine Inflation <b>zwischen 0 und 2 %</b>. Auffällig: Deflation in den 1920er/30er Jahren, Inflationsschübe nach den Weltkriegen und in den Ölkrisen 1973/1981." }),
    panel({ title: "Landesindex der Konsumentenpreise", series: [{ id: "cpi_index", label: "LIK" }], dec: 2, range: "25J", ranges: ["5J", "10J", "25J", "50J", "100J"],
      explain: "Index Dezember 2025 = 100. Ein Wert von 50 heisst: Der Warenkorb kostete damals halb so viel wie heute." }),
  );
  grid.append(teuerungsrechner());
}

function teuerungsrechner() {
  const cpi = annual(S("cpi_index").data);
  const years = [...cpi.keys()].filter((y) => cpi.get(y).n === 12).sort();
  const lastFull = years[years.length - 1];
  const amount = h("input", { type: "number", value: "100", min: "0", step: "1", inputmode: "decimal", "aria-label": "Betrag in Franken" });
  const from = h("select", { "aria-label": "Jahr von" }, years.map((y) => h("option", { value: y, selected: y === "1970" }, y)));
  const to = h("select", { "aria-label": "Jahr bis" }, years.map((y) => h("option", { value: y, selected: y === lastFull }, y)));
  const out = h("div", { class: "calc-out" });
  const calc = () => {
    const a = +amount.value || 0, f = cpi.get(from.value).v, t = cpi.get(to.value).v;
    const res = a * t / f, yrs = +to.value - +from.value;
    const avg = yrs ? (Math.pow(t / f, 1 / yrs) - 1) * 100 : 0;
    out.replaceChildren(`CHF ${fmt(a, 2)} im Jahr ${from.value} entsprechen `, h("b", {}, `CHF ${fmt(res, 2)}`), ` im Jahr ${to.value}.`,
      h("br"), h("span", { class: "note" }, `Preisniveau ${fmtSigned((t / f - 1) * 100, 1)} % · durchschnittliche Inflation ${fmt(avg, 2)} % pro Jahr`));
  };
  [amount, from, to].forEach((e) => e.addEventListener("input", calc));
  calc();
  return h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("div", {}, h("h3", {}, "Teuerungsrechner"), h("div", { class: "sub" }, "Was ist ein Frankenbetrag von damals heute wert?"))),
    h("div", { class: "calc" }, h("label", {}, "Betrag (CHF)", amount), h("label", {}, "Jahr", from), h("label", {}, "umgerechnet ins Jahr", to)),
    out,
    h("p", { class: "explain" }, "Berechnet mit dem Jahresdurchschnitt des Landesindex der Konsumentenpreise (BFS)."));
}

function renderGeld(root) {
  const grid = h("div", { class: "grid" });
  appendAll(root, pageHead("Geld & Zinsen", "Geldmengen und Zinsen zeigen, wie die SNB ihre Geldpolitik umsetzt. Mit dem Leitzins steuert sie das Zinsniveau am Geldmarkt (SARON).",
    [longViewBtn(grid)]), grid);
  grid.append(
    panel({ title: "SNB-Leitzins und SARON", series: [{ id: "policy_rate", label: "SNB-Leitzins" }, { id: "saron", label: "SARON" }], unit: "%", dec: 2, range: "10J", ranges: ["1J", "5J", "10J", "25J"], yZero: true,
      explain: "Den Leitzins gibt es seit Juni 2019 (vorher Zielband für den 3-Monats-Libor). Der SARON ist der Zins, zu dem sich Banken über Nacht gegenseitig Geld leihen." }),
    panel({ title: "Geldmengen M1, M2, M3", series: [{ id: "m1", label: "M1" }, { id: "m2", label: "M2" }, { id: "m3", label: "M3" }], unit: "Mio. CHF", dec: 0, range: "25J", ranges: ["5J", "10J", "25J", "Max"],
      explain: "<b>M1</b> = Bargeld + Sichteinlagen + Transaktionskonti. <b>M2</b> = M1 + Spareinlagen. <b>M3</b> = M2 + Termineinlagen." }),
    panel({ title: "Wachstum der Geldmengen", sub: "ggü. Vorjahresmonat", series: [{ id: "m1_yoy", label: "M1" }, { id: "m3_yoy", label: "M3" }], unit: "%", range: "10J", ranges: ["5J", "10J", "25J", "Max"], yZero: true }),
    panel({ title: "Bargeldumlauf", series: [{ id: "cash", label: "Bargeld" }], unit: "Mio. CHF", dec: 0, range: "25J", ranges: ["10J", "25J", "Max"] }),
    panel({ title: "Rendite 10-jährige Bundesobligationen", series: [{ id: "bond10", label: "Rendite" }], unit: "%", dec: 2, range: "25J", ranges: ["5J", "10J", "25J", "Max"], yZero: true,
      explain: "Der langfristige Zins: Was der Bund für ein Darlehen über 10 Jahre bezahlt." }),
  );
}

function renderMaerkte(root) {
  const grid = h("div", { class: "grid" });
  appendAll(root, pageHead("Finanzmärkte & Franken", "Aktienindizes, Rohstoffe und Wechselkurse. Steigt der Kurs EUR/CHF, wird der Franken schwächer (ein Euro kostet mehr Franken).",
    [longViewBtn(grid)]), grid);
  grid.append(
    panel({ title: "SMI – Swiss Market Index", sub: "Die 20 grössten Schweizer Aktien", series: [{ id: "smi_d", label: "SMI" }], unit: "Punkte", dec: 0, range: "1J", ranges: ["1J"] }),
    panel({ title: "SMI langfristig", sub: "Monatsende", series: [{ id: "smi", label: "SMI" }], unit: "Punkte", dec: 0, range: "Max", ranges: ["5J", "10J", "25J", "Max"] }),
    panel({ title: "Euro und Dollar in Franken (täglich)", series: [{ id: "eurchf_d", label: "EUR/CHF" }, { id: "usdchf_d", label: "USD/CHF" }], unit: "CHF", dec: 4, range: "1J", ranges: ["1J"] }),
    panel({ title: "Wechselkurse langfristig", sub: "Monatsmittel", series: [{ id: "eurchf_m", label: "EUR/CHF" }, { id: "usdchf_m", label: "USD/CHF" }, { id: "gbpchf_m", label: "GBP/CHF" }], unit: "CHF", dec: 3, range: "25J", ranges: ["5J", "10J", "25J", "50J", "Max"],
      explain: "Der Euro existiert seit 1999. Am 15. Januar 2015 hob die SNB den Mindestkurs von 1.20 Franken pro Euro auf (Frankenschock)." }),
    panel({ title: "S&P 500 (USA)", series: [{ id: "spx", label: "S&P 500" }], unit: "Punkte", dec: 0, range: "10J", ranges: ["5J", "10J", "Max"] }),
    panel({ title: "Euro Stoxx 50", series: [{ id: "sx5e", label: "Euro Stoxx 50" }], unit: "Punkte", dec: 0, range: "10J", ranges: ["5J", "10J", "Max"] }),
    panel({ title: "Goldpreis", series: [{ id: "gold", label: "Gold" }], unit: "USD je Unze", dec: 0, range: "10J", ranges: ["5J", "10J", "Max"] }),
    panel({ title: "Erdölpreis (Brent)", series: [{ id: "brent", label: "Brent" }], unit: "USD je Fass", dec: 1, range: "10J", ranges: ["5J", "10J", "Max"] }),
  );
}

function renderArbeit(root) {
  const grid = h("div", { class: "grid" });
  appendAll(root, pageHead("Arbeit", "Arbeitslosenquote nach SECO: registrierte Arbeitslose im Verhältnis zu allen Erwerbspersonen.",
    [longViewBtn(grid), compareBtn("imf_LUR")]), grid);
  grid.append(
    panel({ title: "Arbeitslosenquote", series: [{ id: "unemp_sa", label: "saisonbereinigt" }, { id: "unemp", label: "nicht bereinigt" }], unit: "%", range: "10J", ranges: ["5J", "10J", "25J", "Max"], yZero: true,
      explain: "Saisonbereinigt heisst: typische Schwankungen im Jahresverlauf (z. B. Bau im Winter) sind herausgerechnet." }),
    panel({ title: "Registrierte Arbeitslose", series: [{ id: "unemp_count", label: "Arbeitslose" }], unit: "Personen", dec: 0, range: "25J", ranges: ["5J", "10J", "25J", "Max"], yZero: true }),
    panel({ title: "Gemeldete offene Stellen", series: [{ id: "vacancies", label: "Offene Stellen" }], unit: "Stellen", dec: 0, range: "25J", ranges: ["5J", "10J", "25J", "Max"], yZero: true }),
    panel({ title: "Kurzarbeit", series: [{ id: "shorttime", label: "Kurzarbeitende" }], unit: "Personen", dec: 0, range: "25J", ranges: ["5J", "10J", "25J", "Max"], yZero: true,
      explain: "Kurzarbeit verhindert Entlassungen in Krisen. Corona 2020: über eine Million Personen in Kurzarbeit." }),
    h("section", { class: "panel planned" }, h("h3", {}, "Unbezahlte Arbeit (geplant)"),
      h("p", { class: "explain" }, "Haus- und Familienarbeit, Freiwilligenarbeit nach Geschlecht (BFS, Satellitenkonto Haushaltsproduktion). Kommt in einer nächsten Version.")),
  );
}

function renderUmwelt(root) {
  const grid = h("div", { class: "grid" });
  appendAll(root, pageHead("Umwelt", "CO₂-Emissionen aus fossilen Brennstoffen und Industrie (territorial, d. h. im Inland ausgestossen; ohne importierte Emissionen).",
    [compareBtn("co2_pc")]), grid);
  loadIntl().then(() => {
    grid.append(
      intlPanel({ title: "CO₂-Emissionen pro Kopf", key: "co2_pc", countries: ["CHE", "DEU", "USA", "CHN", "WLD"], range: "50J",
        explain: "Die Schweiz stösst pro Kopf deutlich weniger CO₂ aus als der Weltdurchschnitt, importiert aber viele Emissionen über Konsumgüter." }),
      intlPanel({ title: "CO₂-Emissionen der Schweiz total", key: "co2_total", countries: ["CHE"], range: "Max", dec: 0 }),
    );
  }).catch(intlError(grid));
}

// ======================================================================
// International
// ======================================================================
function loadIntl() {
  if (!intlPromise) intlPromise = fetch(DATA_BASE + "data/intl.json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((j) => { INTL = j; buildMonthlyInflation(); updateStatus(); return j; });
  return intlPromise;
}
function intlError(container) { return () => container.append(h("div", { class: "banner" }, h("div", { class: "msg crit" }, "✕ Internationale Daten konnten nicht geladen werden."))); }
// Neuster Stand eines Länder-Datensatzes: Schweiz, sonst das aktuellste Land
function latestOf(ds) { return ds.countries.CHE ? ds.countries.CHE.at(-1)[0] : Object.values(ds.countries).map((a) => a.at(-1)[0]).sort().at(-1); }
const NAME = (iso) => (INTL && INTL.names[iso]) || iso;

// Monatliche Inflation: Eurostat (harmonisiert) + OECD (übrige Länder) zusammenführen
function buildMonthlyInflation() {
  const hicp = INTL.datasets.hicp, oecd = INTL.datasets.oecd_cpi;
  const countries = {}, src = {};
  if (oecd) for (const [k, v] of Object.entries(oecd.countries)) { countries[k] = v; src[k] = "OECD"; }
  if (hicp) for (const [k, v] of Object.entries(hicp.countries)) { countries[k] = v; src[k] = "Eurostat"; }
  INTL.datasets.infl_m = { title: "Inflation monatlich (ggü. Vorjahresmonat)", unit: "%", freq: "M", source: "Eurostat (HVPI) / OECD",
    link: hicp && hicp.link, fetched: (hicp || oecd || {}).fetched, error: (hicp && hicp.error) || (oecd && oecd.error), countries, src };
}

const INDICATORS = [
  ["infl_m", "Inflation monatlich", 1],
  ["imf_PCPIPCH", "Inflation pro Jahr", 1],
  ["imf_NGDP_RPCH", "Reales BIP-Wachstum", 1],
  ["imf_NGDPDPC", "BIP pro Kopf (nominal, USD)", 0],
  ["imf_PPPPC", "BIP pro Kopf (Kaufkraft)", 0],
  ["imf_NGDPD", "BIP total (Mrd. USD)", 0],
  ["imf_LUR", "Arbeitslosenquote", 1],
  ["imf_GGXWDG_NGDP", "Staatsverschuldung (% BIP)", 1],
  ["imf_BCA_NGDPD", "Leistungsbilanz (% BIP)", 1],
  ["imf_LP", "Bevölkerung (Mio.)", 1],
  ["co2_pc", "CO₂ pro Kopf (t)", 1],
];
const DEC = Object.fromEntries(INDICATORS.map(([k, , d]) => [k, d]));

const GROUPS = {
  nachbarn: ["Nachbarländer", ["CHE", "DEU", "FRA", "ITA", "AUT"]],
  g7: ["G7", ["CHE", "USA", "JPN", "DEU", "GBR", "FRA", "ITA", "CAN"]],
  brics: ["BRICS", ["CHE", "BRA", "RUS", "IND", "CHN", "ZAF"]],
  klein: ["Kleine offene Volkswirtschaften", ["CHE", "AUT", "SWE", "NOR", "DNK", "NLD", "IRL", "SGP"]],
  asien: ["Asien", ["CHE", "CHN", "JPN", "IND", "KOR", "IDN", "SGP", "VNM"]],
  hoch: ["Hohe Inflation", ["CHE", "TUR", "ARG", "EGY", "NGA", "IRN"]],
};
const MONTHLY_GROUPS = {
  nachbarn: ["Nachbarländer", ["CHE", "DEU", "FRA", "ITA", "AUT"]],
  euro: ["Euroraum & EU", ["CHE", "EA20", "EU27", "DEU", "FRA"]],
  welt: ["Grosse Volkswirtschaften", ["CHE", "USA", "GBR", "EA20", "CAN", "KOR", "AUS"]],
  nord: ["Nordeuropa", ["CHE", "SWE", "NOR", "DNK", "NLD"]],
  sued: ["Südeuropa & Türkei", ["CHE", "ITA", "ESP", "PRT", "GRC", "TUR"]],
};

function intlPoints(ds, iso) {
  const arr = ds.countries[iso] || [];
  return arr.map(([d, y]) => ({ x: toX(d), y, d, f: ds.forecastFrom && +d >= ds.forecastFrom }));
}

function intlPanel({ title, key, countries, range = "25J", dec, explain }) {
  const ds = INTL.datasets[key];
  return panel({
    title, unit: ds.unit, dec: dec ?? DEC[key] ?? 1, range, ranges: ["10J", "25J", "50J", "Max"], explain: (explain || "") + (ds.forecastFrom ? `${explain ? "<br>" : ""}Werte ab ${ds.forecastFrom} sind Schätzungen bzw. Prognosen des IWF.` : ""),
    series: countries.filter((c) => ds.countries[c]).map((c) => ({ label: NAME(c), data: ds.countries[c], meta: { ...ds, freq: ds.forecastFrom ? "A" : ds.freq } })),
    file: title,
  });
}

// ---------- Ländervergleich ----------
function parseHashQuery() {
  const q = location.hash.split("?")[1] || "";
  return Object.fromEntries(q.split("&").filter(Boolean).map((kv) => kv.split("=").map(decodeURIComponent)));
}

function renderWelt(root) {
  appendAll(root, pageHead("Ländervergleich", "Wähle eine Kennzahl und eine Ländergruppe oder stelle eigene Länder zusammen (max. 8). Den Link in der Adresszeile kannst du teilen, z. B. für Arbeitsaufträge."));
  const body = h("div", {}, h("p", { class: "loading" }, "Internationale Daten werden geladen …"));
  root.append(body);
  loadIntl().then(() => buildWelt(body)).catch(intlError(body));
}

function buildWelt(body) {
  const q = parseHashQuery();
  let key = INDICATORS.some(([k]) => k === q.i) ? q.i : "infl_m";
  let selected = q.c ? q.c.split(",") : null;
  let range = q.r || null;
  const slots = new Map(); // Land -> Farbslot (bleibt stabil)

  const indSel = h("select", { "aria-label": "Kennzahl" }, INDICATORS.map(([k, l]) => h("option", { value: k, selected: k === key }, l)));
  const groupBox = h("div", { class: "groupbtns" });
  const addSel = h("select", { "aria-label": "Land hinzufügen" });
  const chips = h("div", { class: "chips" });
  const out = h("div", {});
  body.replaceChildren(
    h("div", { class: "controls" }, h("label", {}, "Kennzahl", indSel), h("label", {}, "Ländergruppe", groupBox), h("label", {}, "Land hinzufügen", addSel)),
    chips, out);

  const groups = () => (key === "infl_m" ? MONTHLY_GROUPS : GROUPS);
  function assignSlots() {
    for (const c of [...slots.keys()]) if (!selected.includes(c)) slots.delete(c);
    for (const c of selected) if (!slots.has(c)) { const used = new Set(slots.values()); let s = 0; while (used.has(s)) s++; slots.set(c, s); }
  }
  function setHash() {
    const hash = `#welt?i=${key}&c=${selected.join(",")}${range ? `&r=${range}` : ""}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }
  function render() {
    const ds = INTL.datasets[key];
    if (!selected) selected = [...Object.values(groups())[0][1]];
    selected = selected.filter((c) => ds.countries[c]).slice(0, 8);
    if (!selected.length) selected = ["CHE"];
    assignSlots(); setHash();

    groupBox.replaceChildren(...Object.entries(groups()).map(([gk, [gl, list]]) => {
      const on = list.filter((c) => ds.countries[c]).join() === selected.join();
      return h("button", { class: "btn" + (on ? " on" : ""), type: "button", onclick: () => { selected = list.filter((c) => ds.countries[c]); slots.clear(); render(); } }, gl);
    }));
    const avail = Object.keys(ds.countries).filter((c) => !selected.includes(c)).sort((a, b) => NAME(a).localeCompare(NAME(b), "de"));
    addSel.replaceChildren(h("option", { value: "" }, selected.length >= 8 ? "max. 8 Länder" : "Land wählen …"), ...avail.map((c) => h("option", { value: c }, NAME(c))));
    addSel.disabled = selected.length >= 8;
    chips.replaceChildren(...selected.map((c) => h("span", { class: "chip" }, h("i", { style: `background:${css(SERIES_VARS[slots.get(c)])}` }), NAME(c),
      h("button", { type: "button", "aria-label": `${NAME(c)} entfernen`, onclick: () => { selected = selected.filter((x) => x !== c); render(); } }, "×"))));

    const isM = key === "infl_m";
    const missing = Object.values(groups()).flatMap((g) => g[1]).filter((c) => !ds.countries[c]);
    const p = panel({
      title: ds.title, unit: ds.unit, dec: DEC[key], range: range || (isM ? "10J" : "25J"), ranges: isM ? ["1J", "5J", "10J", "25J"] : ["10J", "25J", "50J", "Max"], tall: true,
      series: selected.map((c) => ({ label: NAME(c), data: ds.countries[c], color: slots.get(c), meta: { ...ds, source: ds.src ? ds.src[c] : ds.source, freq: ds.forecastFrom ? "A" : ds.freq } })),
      explain: [
        isM ? "Europäische Länder: harmonisierter Verbraucherpreisindex (HVPI) von Eurostat – vergleichbar zwischen Ländern, kann für die Schweiz leicht vom LIK abweichen. Übrige Länder: nationaler Konsumentenpreisindex (OECD)." : "",
        ds.forecastFrom ? `Werte ab ${ds.forecastFrom} sind Schätzungen bzw. Prognosen des IWF (World Economic Outlook).` : "",
        staleNote(ds, selected),
      ].filter(Boolean).join(" "),
      file: `${ds.title}_${selected.join("-")}`,
    });
    const origSet = p._setRange;
    p.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => { range = b.dataset.r; setHash(); }));
    p._setRange = origSet;
    out.replaceChildren(p);
    if (missing.length && !isM) out.append(h("p", { class: "note" }, `Keine Daten für: ${[...new Set(missing)].map(NAME).join(", ")}.`));
  }
  indSel.addEventListener("change", () => { key = indSel.value; selected = selected && selected.length ? selected : null; range = null; render(); });
  addSel.addEventListener("change", () => { if (addSel.value) { selected.push(addSel.value); render(); } });
  render();
}

function staleNote(ds, list) {
  if (ds.forecastFrom) return "";
  const stale = list.filter((c) => { const a = ds.countries[c]; return a && (NOW - periodEnd(a[a.length - 1][0])) / DAY > MAX_LAG[ds.freq]; });
  return stale.length ? `<b>⚠ Ältere Daten:</b> ${stale.map((c) => `${NAME(c)} (bis ${fmtPeriod(ds.countries[c].at(-1)[0])})`).join(", ")}.` : "";
}

// ---------- Ranking ----------
const RANK_GROUPS = {
  alle: ["Alle Länder", null],
  europa: ["Europa", ["ALB", "AND", "AUT", "BEL", "BIH", "BGR", "BLR", "CHE", "CYP", "CZE", "DEU", "DNK", "ESP", "EST", "FIN", "FRA", "GBR", "GRC", "HRV", "HUN", "IRL", "ISL", "ITA", "LTU", "LUX", "LVA", "MDA", "MKD", "MLT", "MNE", "NLD", "NOR", "POL", "PRT", "ROU", "RUS", "SMR", "SRB", "SVK", "SVN", "SWE", "TUR", "UKR", "UVK"]],
  oecd: ["OECD", ["AUS", "AUT", "BEL", "CAN", "CHE", "CHL", "COL", "CRI", "CZE", "DEU", "DNK", "ESP", "EST", "FIN", "FRA", "GBR", "GRC", "HUN", "IRL", "ISL", "ISR", "ITA", "JPN", "KOR", "LTU", "LUX", "LVA", "MEX", "NLD", "NOR", "NZL", "POL", "PRT", "SVK", "SVN", "SWE", "TUR", "USA"]],
  g20: ["G20-Länder + Schweiz", ["ARG", "AUS", "BRA", "CAN", "CHN", "DEU", "FRA", "GBR", "IDN", "IND", "ITA", "JPN", "KOR", "MEX", "RUS", "SAU", "TUR", "USA", "ZAF", "CHE"]],
  brics: ["BRICS+ und Schweiz", ["BRA", "RUS", "IND", "CHN", "ZAF", "EGY", "ETH", "IRN", "ARE", "IDN", "CHE"]],
};

function renderRanking(root) {
  appendAll(root, pageHead("Ranking", "Länder sortiert nach einer Kennzahl. Die Schweiz ist hervorgehoben."));
  const body = h("div", {}, h("p", { class: "loading" }, "Internationale Daten werden geladen …"));
  root.append(body);
  loadIntl().then(() => buildRanking(body)).catch(intlError(body));
}

function buildRanking(body) {
  const q = parseHashQuery();
  const keys = INDICATORS.filter(([k]) => k !== "infl_m");
  let key = keys.some(([k]) => k === q.i) ? q.i : "imf_NGDPDPC";
  let grp = RANK_GROUPS[q.g] ? q.g : "alle";
  let top = q.n || "30";
  let year = q.y || null;
  let asc = false;

  const indSel = h("select", { "aria-label": "Kennzahl" }, keys.map(([k, l]) => h("option", { value: k, selected: k === key }, l)));
  const grpSel = h("select", { "aria-label": "Ländergruppe" }, Object.entries(RANK_GROUPS).map(([k, [l]]) => h("option", { value: k, selected: k === grp }, l)));
  const yearSel = h("select", { "aria-label": "Jahr" });
  const topSel = h("select", { "aria-label": "Anzahl" }, [["10", "Top 10"], ["30", "Top 30"], ["60", "Top 60"], ["all", "Alle"]].map(([v, l]) => h("option", { value: v, selected: v === top }, l)));
  const orderBtn = h("button", { class: "btn", type: "button" }, "Höchste zuerst");
  const out = h("div", {});
  body.replaceChildren(h("div", { class: "controls" },
    h("label", {}, "Kennzahl", indSel), h("label", {}, "Jahr", yearSel), h("label", {}, "Länder", grpSel), h("label", {}, "Anzeigen", topSel), h("label", {}, "Reihenfolge", orderBtn)), out);

  function render() {
    const ds = INTL.datasets[key];
    const years = [...new Set(Object.values(ds.countries).flatMap((a) => a.map((r) => r[0])))].sort().reverse();
    const defaultYear = ds.forecastFrom ? String(YEAR - 1) : (ds.countries.CHE ? ds.countries.CHE.at(-1)[0] : years[0]);
    if (!year || !years.includes(year)) year = defaultYear;
    yearSel.replaceChildren(...years.filter((y) => +y >= 1980).map((y) => h("option", { value: y, selected: y === year }, y + (ds.forecastFrom && +y >= ds.forecastFrom ? " (Prognose)" : ""))));
    history.replaceState(null, "", `#ranking?i=${key}&y=${year}&g=${grp}&n=${top}`);

    const members = RANK_GROUPS[grp][1];
    let rows = Object.entries(ds.countries).filter(([c]) => c !== "WLD" && (!members || members.includes(c)))
      .map(([c, a]) => [c, (a.find((r) => r[0] === year) || [])[1]]).filter((r) => r[1] != null)
      .sort((a, b) => (asc ? a[1] - b[1] : b[1] - a[1]));
    const total = rows.length;
    const chPos = rows.findIndex((r) => r[0] === "CHE");
    let shown = top === "all" ? rows : rows.slice(0, +top);
    if (chPos >= shown.length) shown = [...shown, rows[chPos]];
    const dec = DEC[key];

    const canvas = h("canvas", { role: "img", "aria-label": `Ranking ${ds.title}` });
    const hgt = Math.max(220, shown.length * 22 + 40);
    const box = h("div", { class: "chart-box", style: `height:${hgt}px` }, canvas);
    const tbl = h("div", { class: "tablebox" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Rang"), h("th", { style: "text-align:left" }, "Land"), h("th", {}, `${ds.title} (${ds.unit})`))),
      h("tbody", {}, rows.map(([c, v], i) => h("tr", { class: c === "CHE" ? "hl" : "" }, h("td", {}, String(i + 1)), h("td", { style: "text-align:left" }, NAME(c)), h("td", { class: "num" }, fmt(v, dec)))))));
    tbl.hidden = true;
    const tblBtn = h("button", { class: "btn", type: "button", onclick: () => { tbl.hidden = !tbl.hidden; box.hidden = !tbl.hidden; tblBtn.textContent = tbl.hidden ? "Tabelle (alle)" : "Diagramm"; } }, "Tabelle (alle)");
    const csvBtn = h("button", { class: "btn", type: "button", onclick: () => download(`Ranking_${ds.title}_${year}.csv`, toCSV([["Rang", "Land", "ISO", `${ds.title} (${ds.unit})`], ...rows.map(([c, v], i) => [i + 1, NAME(c), c, v])])) }, "CSV");
    const isFc = ds.forecastFrom && +year >= ds.forecastFrom;

    out.replaceChildren(h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("div", {}, h("h3", {}, `${ds.title} ${year}`), h("div", { class: "sub" }, `${ds.unit} · ${RANK_GROUPS[grp][0]} · ${total} Länder mit Daten`))),
      chPos >= 0 ? h("p", { class: "rank-ch" }, "Schweiz: ", h("b", {}, `Rang ${chPos + 1}`), ` von ${total} · ${fmt(rows[chPos][1], dec)} ${ds.unit}`) : h("p", { class: "note" }, "Keine Daten für die Schweiz in diesem Jahr."),
      h("div", { class: "panel-tools" }, h("div", { class: "tools-right" }, tblBtn, csvBtn)),
      box, tbl,
      h("p", { class: "explain" }, isFc ? `Achtung: ${year} ist eine Schätzung bzw. Prognose des IWF.` : "")));

    const old = charts.get("rank"); if (old) old.destroy();
    const ch = css("--s1"), neutral = css("--bar-neutral");
    const chart = new Chart(canvas, {
      type: "bar",
      data: { labels: shown.map(([c]) => NAME(c)), datasets: [{ data: shown.map((r) => r[1]), backgroundColor: shown.map(([c]) => (c === "CHE" ? ch : neutral)), borderRadius: 3, borderSkipped: false, barPercentage: 0.8, categoryPercentage: 1 }] },
      options: {
        indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { backgroundColor: css("--surface"), titleColor: css("--text"), bodyColor: css("--text-2"), borderColor: css("--border"), borderWidth: 1,
          callbacks: { title: (it) => `${rows.findIndex((r) => NAME(r[0]) === it[0].label) + 1}. ${it[0].label}`, label: (it) => ` ${fmt(it.raw, dec)} ${ds.unit}` } } },
        scales: {
          x: { grid: { color: css("--grid") }, border: { display: false }, ticks: { color: css("--muted"), callback: (v) => fmt(v, 0) } },
          y: { grid: { display: false }, border: { color: css("--grid") }, ticks: { color: css("--text-2"), autoSkip: false, font: { size: 12 },
            callback(v) { const c = shown[v]; return `${rows.indexOf(c) + 1}. ${NAME(c[0])}`; } } },
        },
      },
    });
    charts.set("rank", chart);
  }
  indSel.addEventListener("change", () => { key = indSel.value; year = null; render(); });
  yearSel.addEventListener("change", () => { year = yearSel.value; render(); });
  grpSel.addEventListener("change", () => { grp = grpSel.value; render(); });
  topSel.addEventListener("change", () => { top = topSel.value; render(); });
  orderBtn.addEventListener("click", () => { asc = !asc; orderBtn.textContent = asc ? "Tiefste zuerst" : "Höchste zuerst"; render(); });
  render();
}

// ---------- Quellen (Datenstand aller Reihen) ----------
// Gesamtzustand für die Ampel: rot = automatisches Update ausgefallen,
// gelb = einzelne Reihen veraltet/fehlerhaft, grün = alles in Ordnung.
function allStatuses() {
  const rows = Object.entries(CH.series).map(([id, s]) => ({ id, obj: s, st: status(s), intl: false }));
  if (INTL) for (const [k, ds] of Object.entries(INTL.datasets)) {
    if (k === "infl_m") continue;
    rows.push({ id: k, obj: ds, st: status(ds, { lastDate: latestOf(ds), hasForecast: !!ds.forecastFrom }), intl: true });
  }
  return rows;
}
function overall() {
  const ageH = (NOW - new Date(CH.generated)) / 36e5;
  const problems = allStatuses().filter((r) => r.st.level !== "ok" && !r.st.age);
  if (ageH > MAX_FETCH_AGE_H) return { level: "crit", text: "Update ausgefallen", long: `Seit ${Math.floor(ageH / 24)} Tagen keine neuen Daten. Das automatische Update funktioniert nicht.`, problems };
  if (problems.length) return { level: "warn", text: problems.length === 1 ? "1 Reihe veraltet" : `${problems.length} Reihen veraltet`, long: problems.map((r) => r.obj.title).join(", "), problems };
  return { level: "ok", text: "Daten aktuell", long: "Alle Datenreihen sind auf dem neusten Stand.", problems };
}
function fmtShort(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("de-CH", { day: "numeric", month: "numeric" }) + ", " + d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
}
function updateStatus() {
  const o = overall();
  const el = $("#status");
  el.replaceChildren(h("i", { class: `dot ${o.level}` }), h("span", {}, `${o.text} · Stand ${fmtShort(CH.generated)}`));
  el.title = `${o.long} – Klick: Quellen`;
}

function renderQuellen(root) {
  appendAll(root, pageHead("Quellen", "Woher die Zahlen kommen und wie aktuell sie sind. Jede Reihe kann als CSV (für Excel) heruntergeladen werden."));
  const sum = h("div", { class: "cockpit-sum" });
  root.append(sum);
  const paintSum = () => {
    const o = overall();
    sum.replaceChildren(
      h("div", { class: "big" }, h("i", { class: `dot ${o.level}` }), o.text),
      h("div", { class: "facts" },
        h("span", {}, `Letztes Update: ${fmtDateTime(CH.generated)}`),
        h("span", {}, "Automatische Updates: täglich ca. 06:15 und 17:15 Uhr"),
        o.level !== "ok" ? h("span", {}, o.long) : null));
  };
  paintSum();

  const legend = h("p", { class: "note" }, h("i", { class: "dot ok sm" }), " aktuell  ", h("i", { class: "dot warn sm" }), " neuerer Wert wäre zu erwarten  ", h("i", { class: "dot crit sm" }), " Abruf fehlgeschlagen oder Update ausgefallen");
  const mk = (rows) => h("div", { class: "tablebox cockpit", style: "max-height:none" }, h("table", {},
    h("thead", {}, h("tr", {}, ["", "Datenreihe", "Neuster Wert", "Stand", "Hinweis", "Quelle", ""].map((t, i) => h("th", { style: [1, 4, 5].includes(i) ? "text-align:left" : "" }, t)))),
    h("tbody", {}, rows)));
  const order = { crit: 0, warn: 1, ok: 2 };
  const statusCell = (st) => h("td", {}, h("i", { class: `dot ${st.level}`, title: st.text }));
  const srcCell = (o) => h("td", { style: "text-align:left" }, o.link ? h("a", { href: o.link, target: "_blank", rel: "noopener" }, o.source) : o.source);

  root.append(h("h2", { class: "section-title" }, "Schweiz & Finanzmärkte"), legend);
  const chRows = Object.entries(CH.series).map(([id, s]) => ({ id, s, st: status(s) })).sort((a, b) => order[a.st.level] - order[b.st.level]);
  root.append(mk(chRows.map(({ id, s, st }) => {
    const l = s.data.at(-1) || [];
    return h("tr", {}, statusCell(st), h("td", { style: "text-align:left" }, `${s.title} (${s.unit})`), h("td", { class: "num" }, fmtBig(l[1], s.unit)), h("td", {}, fmtPeriod(l[0] || "")),
      h("td", { class: "reason" }, st.level === "ok" ? "" : st.long), srcCell(s),
      h("td", {}, h("button", { class: "btn", type: "button", onclick: () => download(`${id}.csv`, toCSV([["Periode", `${s.title} (${s.unit})`], ...s.data])) }, "CSV")));
  })));

  const intlBox = h("div", {}, h("p", { class: "loading" }, "Internationale Daten werden geladen …"));
  root.append(h("h2", { class: "section-title" }, "International"), intlBox);
  loadIntl().then(() => {
    paintSum();
    intlBox.replaceChildren(mk(Object.entries(INTL.datasets).filter(([k]) => k !== "infl_m").map(([k, ds]) => {
      const lastP = latestOf(ds);
      const st = status(ds, { lastDate: lastP, hasForecast: !!ds.forecastFrom });
      return h("tr", {}, statusCell(st), h("td", { style: "text-align:left" }, `${ds.title} (${ds.unit})`), h("td", {}, `${Object.keys(ds.countries).length} Länder`),
        h("td", {}, fmtPeriod(lastP) + (ds.forecastFrom ? " (inkl. Prognose)" : "")),
        h("td", { class: "reason" }, st.level === "ok" ? "" : st.long), srcCell(ds),
        h("td", {}, h("button", { class: "btn", type: "button", onclick: () => {
          const years = [...new Set(Object.values(ds.countries).flatMap((a) => a.map((r) => r[0])))].sort();
          const isos = Object.keys(ds.countries).sort((a, b) => NAME(a).localeCompare(NAME(b), "de"));
          const maps = isos.map((c) => new Map(ds.countries[c]));
          download(`${k}.csv`, toCSV([["Land", "ISO", ...years], ...isos.map((c, i) => [NAME(c), c, ...years.map((y) => maps[i].get(y) ?? "")])]));
        } }, "CSV")));
    })));
    if (CH.errors.length || INTL.errors.length) root.append(h("h2", { class: "section-title" }, "Technische Fehlermeldungen beim letzten Abruf"),
      h("pre", { class: "note", style: "white-space:pre-wrap" }, [...CH.errors, ...INTL.errors].join("\n")));
  }).catch(intlError(intlBox));
}

// ======================================================================
// Navigation, Start
// ======================================================================

const RENDER = { ueberblick: renderOverview, wachstum: renderWachstum, preise: renderPreise, geld: renderGeld, maerkte: renderMaerkte, arbeit: renderArbeit, umwelt: renderUmwelt, welt: renderWelt, ranking: renderRanking, quellen: renderQuellen, daten: renderQuellen };
let currentPage = null;

function route(force = false) {
  const id = (location.hash.slice(1).split("?")[0]) || "ueberblick";
  const page = RENDER[id] ? id : "ueberblick";
  if (page === currentPage && !force) return;
  currentPage = page;
  for (const c of charts.values()) c.destroy();
  charts.clear();
  $("#tabs").querySelectorAll("a").forEach((a) => a.classList.toggle("active", a.dataset.p === (page === "daten" ? "quellen" : page)));
  const app = $("#app");
  app.replaceChildren();
  RENDER[page](app);
  const t = PAGES.find((p) => p.id === page) || PAGES.find((p) => p.id === "quellen");
  document.title = page === "ueberblick" ? "Wirtschaftsdaten Schweiz" : `${t.label} – Wirtschaftsdaten Schweiz`;
  window.scrollTo(0, 0);
}

function initTheme() {
  const btn = $("#themeBtn");
  let theme = null;
  try { theme = localStorage.getItem("theme"); } catch (e) { /* ignorieren */ }
  if (theme) document.documentElement.dataset.theme = theme;
  btn.addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) { /* ignorieren */ }
    route(true);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => route(true));
}

async function init() {
  $("#tabs").append(...PAGES.map((p) => h("a", { href: "#" + p.id, "data-p": p.id }, p.label)));
  initTheme();
  if (typeof Chart === "undefined") {
    $("#app").replaceChildren(h("div", { class: "banner" }, h("div", { class: "msg crit" }, "✕ Die Diagramm-Bibliothek konnte nicht geladen werden. Besteht eine Internetverbindung?")));
    return;
  }
  Chart.defaults.font.family = css("--font").replace(/"/g, "'") || "system-ui";
  try {
    const r = await fetch(DATA_BASE + "data/data.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    CH = await r.json();
  } catch (e) {
    $("#app").replaceChildren(h("div", { class: "banner" }, h("div", { class: "msg crit" }, `✕ Die Daten konnten nicht geladen werden (${e.message}).`)));
    return;
  }
  updateStatus();
  window.addEventListener("hashchange", () => route());
  route(true);
  loadIntl().catch(() => {});
}
init();
