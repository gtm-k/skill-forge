// SkillForge visual manager — hand-written vanilla JS (no framework, no bundler, zero-install). The browser
// does ZERO business logic (PLAN §9): all sourcing / normalize / select / inject / exec run in the daemon
// via @skillforge/core. This file ONLY calls the Phase-2 daemon REST+SSE control API (served SAME-ORIGIN by
// the daemon) and RENDERS the six surfaces: Sources, Skills browser, Inspect drawer, Route/Test, Activity,
// Status/Settings. Untrusted skill content (descriptions, SKILL.md, scripts, log tails) is rendered ONLY via
// text nodes / escapeHtml — never raw innerHTML. Every fetch has a visible loading + error state; a daemon
// 4xx/5xx body is SHOWN, never a silent empty view. The API surface is @skillforge/contracts/api.

// ───────── tiny DOM helpers ─────────
const $ = (sel, root = document) => root.querySelector(sel);

// Keys set as DOM PROPERTIES (the rest go through setAttribute so aria-*/role/data-*/style reflect to the
// DOM, and on*-handlers bind as listeners). This keeps untrusted text on textContent / text nodes (XSS-safe).
const DIRECT_PROPS = new Set([
  "className", "id", "textContent", "value", "type", "placeholder", "title", "disabled",
  "hidden", "checked", "tabIndex", "htmlFor", "rows", "selected", "href", "name", "autocomplete",
]);
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (DIRECT_PROPS.has(k)) node[k] = v;
    else if (k.startsWith("on")) {
      // bind a listener ONLY for a function value; never fall through to setAttribute (which would install
      // an inline `onclick="…"` HTML handler from a non-function value — an injection foot-gun, never wanted).
      if (typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    } else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c?.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Escape untrusted text before it EVER touches innerHTML (used by the markdown renderer only). */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Capability flag glyphs — paired with the text label so meaning never rides on color alone (a11y).
const FLAG_ICON = { network: "⇅", "pipe-to-shell": "»", destructive: "⚠", eval: "ƒ", install: "↓", "fs-write": "✎" };
const TARGETS = ["lmstudio", "mcp", "proxy"];
const TARGET_LABEL = { lmstudio: "LM Studio", mcp: "MCP", proxy: "Proxy" };

function fmt(n) { return typeof n === "number" ? (Number.isInteger(n) ? String(n) : n.toFixed(3)) : String(n); }
function fmtTs(ts) { try { return new Date(ts).toLocaleTimeString(); } catch { return String(ts); } }
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000); if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60); return `${h}h ${m % 60}m`;
}

// ───────── the daemon API client (typed errors, bounded timeout, never-silent) ─────────
class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}
/** fetch JSON from the same-origin daemon. Throws ApiError on a non-2xx OR a transport/timeout failure, so
 *  EVERY caller can render the daemon's typed error body (never an empty 200). 0 status = could not reach. */
async function api(method, path, body, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e?.name === "AbortError" ? `request timed out after ${timeoutMs}ms` : `cannot reach the daemon (${e?.message ?? e})`;
    throw new ApiError(msg, 0, null);
  }
  clearTimeout(timer);
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON body */ } }
  if (!res.ok) {
    const detail = data && typeof data === "object"
      ? `${data.error ?? "error"}${data.reason ? ": " + data.reason : ""}${data.message ? " — " + data.message : ""}`
      : `HTTP ${res.status}`;
    throw new ApiError(detail, res.status, data);
  }
  return data;
}

// ───────── toast notices (transient success / error — never silent) ─────────
function toast(message, kind = "info") {
  const t = el("div", { className: `toast toast-${kind}`, role: "status" },
    el("span", { className: "toast-icon", "aria-hidden": "true" }, kind === "err" ? "✕" : kind === "ok" ? "✓" : "ℹ"),
    el("span", {}, message),
  );
  $("#toasts").append(t);
  setTimeout(() => t.classList.add("toast-out"), 4200);
  setTimeout(() => t.remove(), 4800);
}
function errMsg(e) { return e instanceof ApiError ? e.message : (e?.message ?? String(e)); }

// ───────── shared state ─────────
let allSkills = [];                 // ManifestSkillEntry[] from GET /skills
const skillById = new Map();
const resyncDiffs = new Map();      // skillId → CapabilityChange (populated by a Sources re-sync, shown in Inspect)
const revokedBySource = new Map();  // sourceId → string[] revoked grant ids (last resync)

function indexSkills() {
  skillById.clear();
  for (const s of allSkills) skillById.set(s.id, s);
}

// ───────── view (tab) switching, lazy-load on first show ─────────
const VIEWS = ["skills", "sources", "route", "activity", "status"];
const loaded = new Set();
function showView(name) {
  for (const tab of document.querySelectorAll(".tab")) tab.setAttribute("aria-selected", String(tab.dataset.view === name));
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== name;
  if (!loaded.has(name)) { loaded.add(name); lazyLoad(name); }
}
function lazyLoad(name) {
  if (name === "sources") loadSources();
  else if (name === "activity") initActivity();
  else if (name === "status") loadStatus();
}
for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => showView(tab.dataset.view));

// ════════════════════════════ Surface: Skills browser ════════════════════════════
async function loadSkills() {
  const grid = $("#skill-grid");
  grid.setAttribute("aria-busy", "true");
  try {
    allSkills = await api("GET", "/skills");
    if (!Array.isArray(allSkills)) allSkills = [];
  } catch (e) {
    grid.setAttribute("aria-busy", "false");
    grid.replaceChildren(errorPanel(`Failed to load skills: ${errMsg(e)}`, loadSkills));
    return;
  }
  grid.setAttribute("aria-busy", "false");
  indexSkills();
  renderStats();
  renderGrid();
}

function renderStats() {
  const flagged = allSkills.filter((s) => (s.capabilities?.flags?.length ?? 0) > 0).length;
  $("#stat-skills").textContent = String(allSkills.length);
  $("#stat-flagged").textContent = String(flagged);
}

function skillFilters() {
  return {
    q: $("#skill-search").value.trim().toLowerCase(),
    target: $("#skill-target-filter").value,
    enabledOnly: $("#skill-enabled-only").checked,
    flaggedOnly: $("#skill-flagged-only").checked,
  };
}
function matchesQuery(skill, q) {
  if (!q) return true;
  const hay = [
    skill.name, skill.slug, skill.description,
    ...(skill.capabilities?.flags ?? []),
    ...(skill.provenance ?? []).map((p) => `${p.kind} ${p.input}`),
  ].join(" ").toLowerCase();
  return hay.includes(q);
}
function enabledFor(skill, target) { return skill.enabledFor?.[target] !== false; }

function renderGrid() {
  const grid = $("#skill-grid");
  const f = skillFilters();
  const filtered = allSkills.filter((s) =>
    matchesQuery(s, f.q) &&
    (!f.target || enabledFor(s, f.target)) &&
    (!f.enabledOnly || (!f.target ? TARGETS.some((t) => enabledFor(s, t)) : enabledFor(s, f.target))) &&
    (!f.flaggedOnly || (s.capabilities?.flags?.length ?? 0) > 0));
  $("#skills-count").textContent = `${filtered.length} of ${allSkills.length}`;
  if (filtered.length === 0) {
    grid.replaceChildren(el("p", { className: "empty" },
      allSkills.length ? "No skills match your filter." : "No skills yet — add a source on the Sources tab."));
    return;
  }
  grid.replaceChildren(...filtered.map(skillCard));
}

function skillCard(skill) {
  const head = el("div", { className: "skill-card-head" },
    el("h3", {}, skill.name || skill.slug),
    el("span", { className: "skill-slug" }, skill.slug),
  );
  const openInspect = () => openDrawer(skill.id);
  const card = el("article", { className: "skill-card" },
    el("button", { className: "skill-card-main", type: "button", "aria-label": `Inspect ${skill.name || skill.slug}`, onClick: openInspect },
      head,
      el("p", { className: "skill-prov mono" }, provLine(skill)),
      el("p", { className: "skill-desc" }, skill.description || "(no description)"),
      capChips(skill),
    ),
    enableToggles(skill),
  );
  return card;
}

function provLine(skill) {
  const prov = skill.provenance ?? [];
  const p = prov[0];
  if (!p) return "no provenance";
  const dedup = prov.length > 1 ? `  ·  shared by ${prov.length} sources` : "";
  return `${p.kind} · ${p.input}${dedup}`;
}

function capChips(skill) {
  const caps = skill.capabilities ?? { scriptCount: 0, flags: [] };
  const chips = el("div", { className: "chips" });
  if (typeof skill.qualityScore === "number") chips.append(chip("quality", "◷", `quality ${skill.qualityScore}`));
  if (skill.isPlaceholder) chips.append(chip("warn", "○", "placeholder"));
  if (skill.execAllowed) chips.append(chip("exec", "▶", "exec allowed"));
  // C4 owner MCP run-mute — a NON-COLOR affordance (mute glyph + "mcp muted" text label, never color alone).
  if (skill.mcpRunMuted) chips.append(chip("muted", "⊘", "mcp muted"));
  if (caps.scriptCount > 0) chips.append(el("span", { className: "chip" }, `${caps.scriptCount} script${caps.scriptCount === 1 ? "" : "s"}`));
  if ((caps.flags ?? []).length === 0) chips.append(chip("clean", "✓", "no flags noticed"));
  else for (const fl of caps.flags) chips.append(chip("flag", FLAG_ICON[fl] ?? "•", fl));
  return chips;
}
function chip(kind, icon, label) {
  return el("span", { className: `chip chip-${kind}` }, el("i", { className: "chip-icon", "aria-hidden": "true" }, icon), label);
}

// THREE per-target enable toggles (LM Studio / MCP / Proxy) — role=switch, paired state TEXT (never color-only).
function enableToggles(skill) {
  const row = el("div", { className: "toggle-row", role: "group", "aria-label": `enable ${skill.slug} per target` });
  for (const t of TARGETS) {
    const on = enabledFor(skill, t);
    const btn = el("button", {
      type: "button", className: `toggle ${on ? "toggle-on" : "toggle-off"}`,
      role: "switch", "aria-checked": String(on),
      onClick: () => flipEnabled(skill, t, btn),
    },
      el("span", { className: "toggle-knob", "aria-hidden": "true" }),
      el("span", { className: "toggle-label" }, TARGET_LABEL[t]),
      el("span", { className: "toggle-state" }, on ? "on" : "off"),
    );
    row.append(btn);
  }
  return row;
}
async function flipEnabled(skill, target, btn) {
  const next = !enabledFor(skill, target);
  btn.disabled = true;
  try {
    await api("POST", `/skills/${encodeURIComponent(skill.id)}/enabled`, { target, on: next });
    skill.enabledFor = { ...(skill.enabledFor ?? {}), [target]: next };
    btn.disabled = false;
    btn.className = `toggle ${next ? "toggle-on" : "toggle-off"}`;
    btn.setAttribute("aria-checked", String(next));
    $(".toggle-state", btn).textContent = next ? "on" : "off";
  } catch (e) {
    btn.disabled = false;
    toast(`Could not toggle ${TARGET_LABEL[target]} for ${skill.slug}: ${errMsg(e)}`, "err");
  }
}

for (const id of ["#skill-search", "#skill-target-filter", "#skill-enabled-only", "#skill-flagged-only"]) {
  $(id).addEventListener("input", renderGrid);
}

// ════════════════════════════ Surface: Inspect drawer ════════════════════════════
const drawer = $("#drawer");
const scrim = $("#drawer-scrim");
let drawerDetail = null;     // SkillDetail (entry + instructions + neighbors)
let drawerTab = "overview";
let lastFocus = null;

async function openDrawer(id) {
  lastFocus = document.activeElement;
  drawerDetail = null;
  drawer.hidden = false;
  scrim.hidden = false;
  openDrawerChrome();
  $("#drawer-title").textContent = "Loading…";
  $("#drawer-slug").textContent = id;
  $("#drawer-prov").textContent = "";
  $("#drawer-foot").replaceChildren();
  $("#drawer-body").replaceChildren(el("p", { className: "dim mono" }, "Loading skill detail…"));
  drawer.focus();
  try {
    drawerDetail = await api("GET", `/skills/${encodeURIComponent(id)}`);
  } catch (e) {
    $("#drawer-title").textContent = "Inspect";
    $("#drawer-body").replaceChildren(errorPanel(`Could not load this skill: ${errMsg(e)}`, () => openDrawer(id)));
    return;
  }
  const e = drawerDetail.entry;
  $("#drawer-title").textContent = e.name || e.slug;
  $("#drawer-slug").textContent = e.slug;
  const p = (e.provenance ?? [])[0];
  $("#drawer-prov").textContent = p ? `source: ${p.kind} · ${p.input}${p.ref ? " @ " + p.ref : ""}  ·  ${e.dir}` : e.dir;
  selectDrawerTab(drawerTab);
  renderExecFooter();
}

// Background regions hidden from focus + AT while the modal drawer is open (so Tab/AT cannot reach the
// obscured page). `inert` covers both; toggled on open/close. The Tab focus-trap below is the keyboard
// belt-and-suspenders so wrap works even where `inert` is unsupported.
const BG_REGIONS = [".app-header", ".tabbar", "#main"];
function setBackgroundInert(on) {
  for (const sel of BG_REGIONS) {
    const node = $(sel);
    if (!node) continue;
    if (on) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
  }
}
function focusableInDrawer() {
  return [...drawer.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((n) => n.getClientRects().length > 0); // visible only (display:none / hidden → 0 rects)
}
function trapFocus(e) {
  if (e.key !== "Tab" || drawer.hidden) return;
  const items = focusableInDrawer();
  if (items.length === 0) { e.preventDefault(); drawer.focus(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === drawer)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

function openDrawerChrome() {
  setBackgroundInert(true);
  document.addEventListener("keydown", trapFocus, true);
}
function closeDrawer() {
  drawer.hidden = true;
  scrim.hidden = true;
  drawerDetail = null;
  setBackgroundInert(false);
  document.removeEventListener("keydown", trapFocus, true);
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
$("#drawer-close").addEventListener("click", closeDrawer);
scrim.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !drawer.hidden) closeDrawer(); });

// tablist: click + roving tabindex + Left/Right arrow nav (WAI-ARIA tabs pattern). The single drawer body
// is the one tabpanel; selectDrawerTab points its aria-labelledby at the active tab.
const drawerTabs = [...document.querySelectorAll(".drawer-tab")];
for (const t of drawerTabs) {
  t.addEventListener("click", () => selectDrawerTab(t.dataset.tab));
  t.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = drawerTabs.indexOf(t);
    const next = drawerTabs[(i + (e.key === "ArrowRight" ? 1 : drawerTabs.length - 1)) % drawerTabs.length];
    selectDrawerTab(next.dataset.tab);
    next.focus();
  });
}

function selectDrawerTab(tab) {
  drawerTab = tab;
  for (const t of drawerTabs) {
    const sel = t.dataset.tab === tab;
    t.setAttribute("aria-selected", String(sel));
    t.tabIndex = sel ? 0 : -1; // roving tabindex: only the selected tab is in the Tab order
    if (sel) $("#drawer-body").setAttribute("aria-labelledby", t.id);
  }
  if (!drawerDetail) return;
  if (tab === "overview") renderOverview();
  else if (tab === "instructions") renderInstructions();
  else renderScripts();
}

function renderOverview() {
  const e = drawerDetail.entry;
  const body = $("#drawer-body");
  const parts = [];

  // frontmatter + quality
  const meta = el("div", { className: "kv" });
  const add = (k, v) => meta.append(el("div", { className: "kv-k" }, k), el("div", { className: "kv-v mono" }, v));
  add("slug", e.slug);
  add("id", e.id);
  if (e.version) add("version", e.version);
  if (e.license) add("license", e.license);
  add("body", `${e.bodyLen} chars · ~${e.tokenEstimate} tok`);
  if (typeof e.qualityScore === "number") add("quality", `${e.qualityScore} / 100`);
  add("placeholder", e.isPlaceholder ? "yes" : "no");
  parts.push(el("div", { className: "panel" }, el("h3", {}, "Frontmatter"), meta));

  // capabilities (humble inventory)
  const caps = e.capabilities ?? { scriptCount: 0, interpreters: [], commands: [], flags: [] };
  const capPanel = el("div", { className: "panel" }, el("h3", {}, "Capabilities — what we noticed"));
  capPanel.append(el("p", { className: "noticed-note" }, "An inventory of what these files contain — not a safety verdict."));
  const capChipsRow = el("div", { className: "chips" });
  if ((caps.flags ?? []).length === 0) capChipsRow.append(chip("clean", "✓", "no flags noticed"));
  else for (const fl of caps.flags) capChipsRow.append(chip("flag", FLAG_ICON[fl] ?? "•", fl));
  capPanel.append(capChipsRow);
  if (caps.interpreters?.length) capPanel.append(el("p", { className: "dim mono mini" }, `interpreters: ${caps.interpreters.join(", ")}`));
  if (caps.commands?.length) capPanel.append(el("p", { className: "dim mono mini" }, `commands: ${caps.commands.join(", ")}`));
  parts.push(capPanel);

  // re-sync capability diff (before → after), when a Sources re-sync recorded a change for this skill
  const diff = resyncDiffs.get(e.id);
  if (diff) parts.push(capabilityDiffPanel(diff));

  // validation warnings
  if ((e.warnings ?? []).length) {
    const w = el("div", { className: "panel" }, el("h3", {}, "Validation warnings"));
    for (const issue of e.warnings) {
      w.append(el("p", { className: `issue issue-${issue.level}` },
        el("span", { className: "issue-badge" }, issue.level),
        `${issue.field ? issue.field + ": " : ""}${issue.msg}`));
    }
    parts.push(w);
  }

  // embedding neighbors (overlap / conflict surface)
  if ((drawerDetail.embeddingNeighbors ?? []).length) {
    const n = el("div", { className: "panel" }, el("h3", {}, "Nearest skills (embedding)"));
    for (const nb of drawerDetail.embeddingNeighbors) {
      n.append(el("div", { className: "neighbor" },
        el("span", { className: "mono" }, nb.slug),
        el("span", { className: "neighbor-cos mono" }, `cos ${fmt(nb.cosine)}`)));
    }
    parts.push(n);
  }
  body.replaceChildren(...parts);
}

function capabilityDiffPanel(diff) {
  const panel = el("div", { className: "panel panel-accent" },
    el("h3", {}, "Re-sync capability change"),
    el("p", { className: "noticed-note" }, diff.contentHashChanged ? "The bundle bytes changed on the last re-sync." : "Capabilities changed on the last re-sync."));
  const flagsLine = (caps) => {
    const wrap = el("div", { className: "chips" });
    const flags = caps?.flags ?? [];
    if (!flags.length) wrap.append(chip("clean", "✓", "no flags"));
    else for (const fl of flags) wrap.append(chip("flag", FLAG_ICON[fl] ?? "•", fl));
    return wrap;
  };
  panel.append(el("div", { className: "diff" },
    el("div", { className: "diff-col" }, el("span", { className: "diff-label" }, "before"), flagsLine(diff.before)),
    el("span", { className: "diff-arrow", "aria-hidden": "true" }, "→"),
    el("div", { className: "diff-col" }, el("span", { className: "diff-label" }, "after"), flagsLine(diff.after)),
  ));
  return panel;
}

async function renderInstructions() {
  const body = $("#drawer-body");
  const md = el("div", { className: "md" });
  md.innerHTML = renderMarkdown(drawerDetail.instructions || "");   // escape-first renderer (XSS-safe)
  if (!drawerDetail.instructions) body.replaceChildren(el("p", { className: "dim mono" }, "This skill has no SKILL.md body."));
  else body.replaceChildren(md);
}

function renderScripts() {
  const e = drawerDetail.entry;
  const body = $("#drawer-body");
  const bundle = (e.bundle ?? []).filter((b) => b.kind !== "instructions");
  const parts = [el("p", { className: "noticed-note" }, "Capability flags are what we NOTICED in these files — an inventory, not a safety verdict.")];
  if (bundle.length === 0) {
    body.replaceChildren(el("p", { className: "dim mono" }, "No scripts, references, or assets — only SKILL.md."));
    return;
  }
  for (const b of bundle) {
    const head = el("button", { className: "file-entry-head", type: "button", "aria-expanded": "false", onClick: (ev) => toggleFile(ev.currentTarget, e.id, b) },
      el("span", { className: "file-path mono" }, b.relPath),
      el("span", { className: `kind-badge kind-${b.kind}` }, b.kind),
    );
    const meta = el("div", { className: "file-meta" },
      el("span", {}, b.kind),
      b.lang ? el("span", {}, b.lang) : null,
      el("span", {}, `${b.bytes} B`),
      b.shebang ? el("span", {}, `#! ${b.shebang}`) : null,
      b.exec ? el("span", {}, `interp: ${b.exec.interpreter}`) : null,
    );
    const entry = el("div", { className: "file-entry" }, head, meta);
    if (b.exec?.declaredCommands?.length) entry.append(el("div", { className: "file-cmds mono" }, `declared commands: ${b.exec.declaredCommands.join(", ")}`));
    entry.append(el("div", { className: "file-viewer", hidden: true }));
    parts.push(entry);
  }
  body.replaceChildren(...parts);
}

async function toggleFile(head, id, b) {
  const entry = head.closest(".file-entry");
  const viewer = $(".file-viewer", entry);
  const open = viewer.hidden;
  head.setAttribute("aria-expanded", String(open));
  viewer.hidden = !open;
  if (!open) return;
  if (viewer.dataset.loaded === "1") return;
  viewer.replaceChildren(el("p", { className: "dim mono mini" }, "Loading file…"));
  let file;
  try {
    file = await api("GET", `/skills/${encodeURIComponent(id)}/file?relPath=${encodeURIComponent(b.relPath)}`);
  } catch (e) {
    viewer.replaceChildren(errorPanel(`Could not read ${b.relPath}: ${errMsg(e)}`, null));
    return;
  }
  viewer.dataset.loaded = "1";
  viewer.replaceChildren(renderFileContents(file));
}

// Render full file text with flaggedLines highlighted by class + the FLAG_ICON + a text label per flag.
function renderFileContents(file) {
  const flagsByLine = new Map();
  for (const fl of file.flaggedLines ?? []) {
    if (!flagsByLine.has(fl.line)) flagsByLine.set(fl.line, new Set());
    flagsByLine.get(fl.line).add(fl.flag);
  }
  const wrap = el("div", {});
  const summary = el("div", { className: "file-meta" },
    el("span", {}, file.lang ? file.lang : "text"),
    el("span", {}, `${file.bytes} B`),
    file.truncated ? el("span", { className: "trunc" }, "display truncated") : null,
    (file.flaggedLines ?? []).length ? el("span", { className: "flag-count" }, `${file.flaggedLines.length} flagged line${file.flaggedLines.length === 1 ? "" : "s"}`) : el("span", {}, "no flagged lines"),
  );
  wrap.append(summary);
  const pre = el("pre", { className: "code", tabIndex: 0, "aria-label": `contents of ${file.relPath}` });
  const lines = (file.text ?? "").split(/\r?\n/);
  lines.forEach((line, i) => {
    const n = i + 1;
    const flags = flagsByLine.get(n);
    const row = el("div", { className: `code-line${flags ? " code-line-flagged" : ""}` });
    row.append(el("span", { className: "code-gutter", "aria-hidden": "true" }, String(n)));
    row.append(el("span", { className: "code-text" }, line || " "));
    if (flags) {
      const badges = el("span", { className: "code-flags" });
      for (const fl of flags) badges.append(el("span", { className: "code-flag", title: `noticed: ${fl}` },
        el("i", { className: "chip-icon", "aria-hidden": "true" }, FLAG_ICON[fl] ?? "•"), fl));
      row.append(badges);
    }
    pre.append(row);
  });
  wrap.append(pre);
  if (file.truncated) wrap.append(el("p", { className: "dim mono mini" }, "The display is capped, but the FULL file was scanned for flags above."));
  return wrap;
}

// exec-allowed grant toggle — bound to the reviewed contentHash (D10). A 409 means the bytes changed → re-review.
function renderExecFooter() {
  const e = drawerDetail.entry;
  const foot = $("#drawer-foot");
  const on = e.execAllowed;
  const scripts = e.capabilities?.scriptCount ?? 0;
  const state = el("div", { className: "exec-state" },
    el("span", { className: `exec-pill ${on ? "exec-on" : "exec-off"}` },
      el("i", { className: "chip-icon", "aria-hidden": "true" }, on ? "▶" : "■"), on ? "exec allowed" : "exec blocked"),
    el("span", { className: "dim mono mini" }, scripts ? `${scripts} script${scripts === 1 ? "" : "s"} · default-deny until you allow` : "no scripts in this bundle"),
  );
  const btn = el("button", { type: "button", className: on ? "secondary" : "primary", disabled: scripts === 0, onClick: () => setExec(e, !on, btn) },
    on ? "Revoke exec" : "Allow exec");

  // C4 owner MCP RUN-MUTE — pause/resume MCP script runs for this skill (load/list stay enabled). Independent
  // of the exec grant. aria-pressed + an icon + a text label give a non-color affordance (accessibility).
  const muted = e.mcpRunMuted === true;
  const muteBtn = el("button", {
    type: "button", className: "secondary", "aria-pressed": String(muted),
    title: "When muted, run_skill_script over MCP is refused; load/list still work.",
    onClick: () => setMcpMute(e, !muted, muteBtn),
  },
    el("i", { className: "chip-icon", "aria-hidden": "true" }, muted ? "⊘" : "▶"),
    muted ? "Un-mute MCP runs" : "Mute MCP runs");

  foot.replaceChildren(state, btn, muteBtn);
}
async function setMcpMute(e, on, btn) {
  btn.disabled = true;
  try {
    await api("POST", `/skills/${encodeURIComponent(e.id)}/mcp-mute`, { on });
    e.mcpRunMuted = on;
    const live = skillById.get(e.id); if (live) live.mcpRunMuted = on;
    renderExecFooter();
    renderGrid();
    toast(on ? `MCP runs muted for ${e.slug}` : `MCP runs un-muted for ${e.slug}`, "ok");
  } catch (err) {
    btn.disabled = false;
    toast(`Could not change the MCP run-mute for ${e.slug}: ${errMsg(err)}`, "err");
  }
}
async function setExec(e, on, btn) {
  btn.disabled = true;
  try {
    await api("POST", `/skills/${encodeURIComponent(e.id)}/exec-allowed`, { contentHash: e.contentHash, on });
    e.execAllowed = on;
    const live = skillById.get(e.id); if (live) live.execAllowed = on;
    renderExecFooter();
    renderGrid();
    toast(on ? `Exec allowed for ${e.slug}` : `Exec revoked for ${e.slug}`, "ok");
  } catch (err) {
    btn.disabled = false;
    if (err instanceof ApiError && err.status === 409) {
      toast(`${e.slug} changed on disk since you reviewed it — re-review before granting exec.`, "err");
      openDrawer(e.id); // reload fresh detail (new hash) so the user re-reviews
    } else {
      toast(`Could not change the exec grant: ${errMsg(err)}`, "err");
    }
  }
}

// minimal, SAFE markdown → HTML (escape FIRST, then a tiny block/inline transform). No external dep.
function renderMarkdown(src) {
  const lines = escapeHtml(src).split(/\r?\n/);
  let html = "", inCode = false, inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      if (inCode) { html += "</code></pre>"; inCode = false; }
      else { closeList(); html += "<pre><code>"; inCode = true; }
      continue;
    }
    if (inCode) { html += raw + "\n"; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (h) { closeList(); const n = h[1].length; html += `<h${n}>${inline(h[2])}</h${n}>`; continue; }
    const li = /^[-*]\s+(.*)$/.exec(raw);
    if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (raw.trim() === "") { closeList(); continue; }
    closeList();
    html += `<p>${inline(raw)}</p>`;
  }
  if (inCode) html += "</code></pre>";
  closeList();
  return html;
}
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

// ════════════════════════════ Surface: Sources ════════════════════════════
let pendingSourceInput = null;       // the input previewed and awaiting commit

const sourceForm = $("#source-form");
const sourceInput = $("#source-input");
sourceForm.addEventListener("submit", (e) => { e.preventDefault(); previewSource(); });
sourceInput.addEventListener("input", () => { $("#source-commit-btn").disabled = true; pendingSourceInput = null; });
$("#source-commit-btn").addEventListener("click", commitSource);

// drop zone — browsers cannot expose an absolute local folder path (security), so we accept a dragged/pasted
// URL or path string and prefill the input; a dropped folder prefills its NAME with an honest note.
const dz = $("#source-dropzone");
dz.addEventListener("click", () => sourceInput.focus());
dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sourceInput.focus(); } });
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dz-over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("dz-over"));
dz.addEventListener("drop", (e) => {
  e.preventDefault(); dz.classList.remove("dz-over");
  const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
  if (text && text.trim()) { sourceInput.value = text.trim(); sourceInput.focus(); $("#source-commit-btn").disabled = true; return; }
  const item = e.dataTransfer.items?.[0];
  const entry = item?.webkitGetAsEntry?.();
  if (entry) {
    sourceInput.value = entry.name;
    toast("A browser can't read a folder's absolute path — type the full local path to add it.", "info");
    sourceInput.focus();
  }
});

async function previewSource() {
  const input = sourceInput.value.trim();
  const out = $("#source-preview");
  if (!input) { out.replaceChildren(el("p", { className: "err" }, "Enter a git URL, a local folder path, a registry id, or a .zip url.")); return; }
  const btn = $("#source-preview-btn");
  btn.disabled = true; btn.textContent = "Previewing…";
  out.replaceChildren(el("p", { className: "dim mono" }, "Resolving + inspecting (nothing is committed yet)…"));
  try {
    const preview = await api("POST", "/sources/preview", { input }, { timeoutMs: 30000 });
    pendingSourceInput = input;
    $("#source-commit-btn").disabled = false;
    renderPreview(preview);
  } catch (e) {
    pendingSourceInput = null;
    $("#source-commit-btn").disabled = true;
    out.replaceChildren(errorPanel(`Preview failed: ${errMsg(e)}`, null));
  } finally {
    btn.disabled = false; btn.textContent = "Preview";
  }
}

function renderPreview(p) {
  const out = $("#source-preview");
  const panel = el("div", { className: "panel panel-accent" });
  panel.append(el("h3", {}, "Preview — before commit"));
  panel.append(el("p", { className: "preview-headline" },
    `Adds ${p.skillCount} skill${p.skillCount === 1 ? "" : "s"} carrying ${p.scriptCount} script${p.scriptCount === 1 ? "" : "s"}; ${p.flaggedCount} flagged.`));
  panel.append(el("p", { className: "noticed-note" }, "Here's what we noticed — an inventory, not a safety verdict."));
  if ((p.flags ?? []).length) {
    const chips = el("div", { className: "chips" });
    for (const fl of p.flags) chips.append(chip("flag", FLAG_ICON[fl] ?? "•", fl));
    panel.append(chips);
  }
  if ((p.skills ?? []).length) {
    const list = el("div", { className: "preview-skills" });
    for (const s of p.skills) {
      const flags = s.capabilities?.flags ?? [];
      list.append(el("div", { className: "preview-skill" },
        el("div", { className: "preview-skill-head" },
          el("span", { className: "mono" }, s.slug),
          el("span", { className: "preview-skill-name" }, s.name)),
        el("p", { className: "preview-skill-desc" }, s.description || "(no description)"),
        flags.length ? el("div", { className: "chips" }, ...flags.map((fl) => chip("flag", FLAG_ICON[fl] ?? "•", fl))) : null,
      ));
    }
    panel.append(list);
  }
  if ((p.warnings ?? []).length) {
    const w = el("div", { className: "preview-warns" });
    for (const issue of p.warnings) w.append(el("p", { className: `issue issue-${issue.level}` },
      el("span", { className: "issue-badge" }, issue.level), `${issue.field ? issue.field + ": " : ""}${issue.msg}`));
    panel.append(w);
  }
  out.replaceChildren(panel);
}

async function commitSource() {
  if (!pendingSourceInput) return;
  const btn = $("#source-commit-btn");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    const res = await api("POST", "/sources", { input: pendingSourceInput }, { timeoutMs: 60000 });
    toast(`Added ${res.added} skill${res.added === 1 ? "" : "s"} from the source.`, "ok");
    if (res.embeddingsSkipped > 0) {
      toast(`Tier-2 went lexical-only: ${res.embeddingsSkipped} skill${res.embeddingsSkipped === 1 ? "" : "s"} stored WITHOUT embeddings (provider unreachable).`, "err");
    }
    sourceInput.value = "";
    pendingSourceInput = null;
    $("#source-preview").replaceChildren();
    await Promise.all([loadSkills(), loadSources()]);
  } catch (e) {
    toast(`Could not add the source: ${errMsg(e)}`, "err");
  } finally {
    btn.disabled = true; btn.textContent = "Add source";
  }
}

async function loadSources() {
  const list = $("#sources-list");
  list.setAttribute("aria-busy", "true");
  let sources;
  try {
    sources = await api("GET", "/sources");
  } catch (e) {
    list.setAttribute("aria-busy", "false");
    list.replaceChildren(errorPanel(`Failed to load sources: ${errMsg(e)}`, loadSources));
    return;
  }
  list.setAttribute("aria-busy", "false");
  $("#stat-sources").textContent = String(sources.length);
  if (sources.length === 0) {
    list.replaceChildren(el("p", { className: "empty" }, "No sources yet — add one above."));
    return;
  }
  list.replaceChildren(...sources.map(sourceRow));
}

function sourceRow(s) {
  const statusKind = s.status === "ok" ? "ok" : s.status === "error" ? "err" : "warn";
  const revoked = revokedBySource.get(s.sourceId);
  const row = el("div", { className: "source-row" },
    el("div", { className: "source-meta" },
      el("div", { className: "source-row-head" },
        el("span", { className: `kind-badge kind-${s.kind}` }, s.kind),
        el("span", { className: "source-input mono" }, s.input || s.sourceId)),
      el("div", { className: "source-sub mono" },
        el("span", {}, `${s.skillCount} skill${s.skillCount === 1 ? "" : "s"}`),
        s.ref ? el("span", {}, `@ ${s.ref}`) : null,
        el("span", {}, `synced: ${s.lastSynced ? fmtTs(s.lastSynced) : "never"}`),
        el("span", { className: `status-pill status-${statusKind}` },
          el("i", { className: "chip-icon", "aria-hidden": "true" }, s.status === "ok" ? "✓" : s.status === "error" ? "✕" : "…"), s.status),
      ),
      s.error ? el("p", { className: "err mini" }, s.error) : null,
      revoked && revoked.length ? el("p", { className: "warn mini" }, `last re-sync auto-revoked ${revoked.length} exec grant${revoked.length === 1 ? "" : "s"} (content changed)`) : null,
    ),
    el("div", { className: "source-actions-row" },
      el("button", { type: "button", className: "secondary small", onClick: (ev) => resyncSource(s, ev.currentTarget) }, "Re-sync"),
      el("button", { type: "button", className: "danger small", onClick: () => removeSource(s) }, "Remove"),
    ),
  );
  return row;
}

async function resyncSource(s, btn) {
  btn.disabled = true; btn.textContent = "Re-syncing…";
  try {
    const r = await api("POST", `/sources/${encodeURIComponent(s.sourceId)}/resync`, undefined, { timeoutMs: 60000 });
    for (const c of r.capabilityChanges ?? []) resyncDiffs.set(c.id, c);
    revokedBySource.set(s.sourceId, r.revokedGrants ?? []);
    const bits = [`${r.changed} changed`, `${r.added} added`, `${r.removed} removed`];
    if ((r.revokedGrants ?? []).length) bits.push(`${r.revokedGrants.length} exec grant${r.revokedGrants.length === 1 ? "" : "s"} revoked`);
    toast(`Re-synced: ${bits.join(", ")}.`, (r.revokedGrants ?? []).length ? "err" : "ok");
    await Promise.all([loadSkills(), loadSources()]);
  } catch (e) {
    btn.disabled = false; btn.textContent = "Re-sync";
    toast(`Re-sync failed: ${errMsg(e)}`, "err");
  }
}

async function removeSource(s) {
  if (!confirm(`Remove the source ${s.input || s.sourceId} and all its skills?`)) return;
  try {
    await api("DELETE", `/sources/${encodeURIComponent(s.sourceId)}`);
    revokedBySource.delete(s.sourceId);
    toast("Source removed.", "ok");
    await Promise.all([loadSkills(), loadSources()]);
  } catch (e) {
    toast(`Could not remove the source: ${errMsg(e)}`, "err");
  }
}

// ════════════════════════════ Surface: Route / Test ════════════════════════════
$("#route-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = $("#route-query").value.trim();
  const target = $("#route-target").value;
  const explicit = $("#route-explicit").value.trim();
  const out = $("#route-result");
  if (!query) { out.replaceChildren(el("p", { className: "err" }, "Enter an utterance to route.")); return; }
  const btn = $("#route-submit");
  btn.disabled = true; btn.textContent = "Routing…";
  out.replaceChildren(el("p", { className: "dim mono" }, "Running the real select() in the daemon…"));
  try {
    const reqBody = { target, messages: [{ role: "user", content: query }] };
    if (explicit) reqBody.explicit = explicit.replace(/^\$/, "");
    const r = await api("POST", "/route-test", reqBody, { timeoutMs: 15000 });
    renderRoute(r);
  } catch (err) {
    out.replaceChildren(errorPanel(`Route failed: ${errMsg(err)}`, null));
  } finally {
    btn.disabled = false; btn.textContent = "Route";
  }
});

function renderRoute(r) {
  const out = $("#route-result");
  const parts = [];
  const sel = r.selection;

  // semantic-degraded banner (Tier-2 unavailable → visible, never silent)
  if (r.tierDisabled) {
    parts.push(banner("warn", "⚠", `Semantic tier unavailable — ${r.tierDisabled.reason}. Ranking is lexical only.`));
  } else {
    parts.push(banner("ok", "✓", "Semantic tier active (if the corpus carries embeddings)."));
  }
  if (r.hostDriven) parts.push(banner("info", "ℹ", "MCP is host-driven — these are candidates the host COULD pick, not a deterministic injection."));

  // verdict + θ gauge
  const verdict = el("div", { className: "panel" }, el("h3", {}, "Decision"));
  const pill = el("span", { className: `mode-pill mode-${sel.mode}` }, sel.mode === "none" ? "inject nothing" : sel.mode);
  const detail = sel.chosen
    ? el("span", { className: "verdict-detail" }, `→ ${sel.chosen.slug}  (score ${fmt(sel.chosen.score)}, ${sel.chosen.tier})${sel.ambiguous ? "  · ambiguous" : ""}`)
    : el("span", { className: "verdict-detail" }, sel.belowThreshold ? "a tier ran but nothing cleared its θ gate — a wrong skill is worse than none" : "no skill cleared its threshold");
  verdict.append(el("div", { className: "verdict" }, pill, detail));
  verdict.append(thetaGauge(r.threshold, sel.mode !== "none"));
  parts.push(verdict);

  // candidates
  if ((sel.candidates ?? []).length) {
    const panel = el("div", { className: "panel" }, el("h3", {}, "Ranked candidates"));
    const table = el("table", { className: "cand-table" });
    table.append(el("thead", {}, rowCells("th", ["#", "skill", "score", "tier", "reasons"])));
    const tbody = el("tbody");
    sel.candidates.forEach((c, i) => {
      const tr = el("tr", {});
      const isChosen = sel.chosen && c.slug === sel.chosen.slug;
      if (isChosen) tr.className = "is-chosen";
      const skillCell = el("td", {});
      const nameLine = el("div", { className: "cand-name" });
      const open = c.id && skillById.has(c.id);
      nameLine.append(open
        ? el("button", { type: "button", className: "linkish", onClick: () => openDrawer(c.id) }, c.slug)
        : el("span", { className: "mono" }, c.slug));
      // the chosen row carries an in-row icon+text marker — meaning never rides on the background tint alone.
      if (isChosen) nameLine.append(el("span", { className: "chosen-mark" }, el("i", { className: "chip-icon", "aria-hidden": "true" }, "✓"), "chosen"));
      skillCell.append(nameLine);
      skillCell.append(el("div", { className: "cand-reasons" }, c.tier));
      tr.append(
        el("td", {}, String(i + 1)),
        skillCell,
        el("td", { className: "cand-score mono" }, fmt(c.score)),
        el("td", { className: "mono" }, c.tier),
        el("td", { className: "cand-reasons" }, (c.reasons ?? []).join("; ") || "—"),
      );
      tbody.append(tr);
    });
    table.append(tbody);
    panel.append(table);
    parts.push(panel);
  }

  // injection — the EXACT block handed to the host (or "inject nothing")
  const inj = r.injection ?? {};
  const ipanel = el("div", { className: "panel" }, el("h3", {}, "Injection — what would be handed to the host"));
  ipanel.append(el("div", { className: "inject-meta mono" },
    el("span", {}, el("span", { className: `disclosure-badge disc-${inj.disclosure}` }, inj.disclosure || "none")),
    el("span", {}, "bytes: ", el("b", {}, String(inj.injectedBytes ?? 0))),
    el("span", {}, "tokens: ", el("b", {}, String(inj.tokenCost ?? 0))),
    el("span", {}, "slugs: ", el("b", {}, (inj.injectedSlugs ?? []).join(", ") || "—")),
  ));
  if (inj.text) ipanel.append(el("pre", { className: "inject-block" }, inj.text));
  else ipanel.append(el("p", { className: "inject-empty" }, 'Nothing injected — disclosure "none". The host turn is left untouched.'));
  parts.push(ipanel);

  out.replaceChildren(...parts);
}

// θ gauge — place the top score against the firing gate, so "inject nothing" is legible (§6).
function thetaGauge(th, fired) {
  const { theta, topScore, margin } = th;
  const isCosine = theta <= 1;                     // semantic/explicit gates live in [0,1]; lexical BM25 is unbounded
  const max = isCosine ? 1 : Math.max(theta * 2, topScore * 1.15, 1);
  const label = th.tier === "semantic" ? "cosine" : th.tier === "explicit" ? "explicit" : th.tier === "lexical" ? "BM25" : (isCosine ? "cosine" : "BM25");
  const pct = (x) => Math.max(0, Math.min(100, (x / max) * 100));
  const wrap = el("div", { className: "gauge" });
  wrap.append(el("div", { className: "gauge-label mono" },
    el("span", {}, `top score (${label}): ${fmt(topScore)}`),
    el("span", {}, `θ = ${fmt(theta)}`)));
  const track = el("div", { className: "gauge-track" });
  track.append(el("div", { className: `gauge-fill${fired ? "" : " below"}`, style: `width:${pct(topScore)}%` }));
  track.append(el("div", { className: "gauge-thresh", style: `left:${pct(theta)}%`, title: `firing threshold θ = ${fmt(theta)}` }));
  wrap.append(track);
  wrap.append(el("div", { className: "gauge-foot mono" },
    fired ? `top score is at/above θ → fires (${th.tier})` : `top score is below θ → inject nothing`,
    `  ·  margin to #2 = ${fmt(margin)}`));
  return wrap;
}

// ════════════════════════════ Surface: Activity ════════════════════════════
let activityEvents = [];      // newest-first DaemonEvent[]
let activityPaused = false;
let es = null;                // EventSource
const suppressedKeys = new Set(); // `${conversationId}::${skillId}` already suppressed

async function initActivity() {
  await backfillActivity();
  connectStream();
}
async function backfillActivity() {
  const list = $("#activity-list");
  list.setAttribute("aria-busy", "true");
  const type = $("#activity-type").value;
  try {
    const events = await api("GET", `/activity?limit=200${type ? "&type=" + encodeURIComponent(type) : ""}`);
    activityEvents = Array.isArray(events) ? events.slice().reverse() : []; // log is oldest-first → newest-first
  } catch (e) {
    list.setAttribute("aria-busy", "false");
    list.replaceChildren(errorPanel(`Failed to load activity: ${errMsg(e)}`, backfillActivity));
    return;
  }
  list.setAttribute("aria-busy", "false");
  renderActivity();
}
$("#activity-type").addEventListener("change", () => { renderActivity(); });
$("#activity-pause").addEventListener("click", () => {
  activityPaused = !activityPaused;
  $("#activity-pause").textContent = activityPaused ? "Resume" : "Pause";
  $("#activity-pause").classList.toggle("primary", activityPaused);
});

function connectStream() {
  if (es) return;
  setStreamState("connecting…", "warn");
  try {
    es = new EventSource("/events");
  } catch (e) {
    setStreamState("live stream unavailable", "err");
    return;
  }
  es.addEventListener("open", () => setStreamState("live", "ok"));
  es.addEventListener("error", () => setStreamState("disconnected — retrying…", "err")); // EventSource auto-reconnects
  for (const type of ["selection", "injection", "exec", "source", "staleness"]) {
    es.addEventListener(type, (ev) => {
      let parsed; try { parsed = JSON.parse(ev.data); } catch { return; }
      onLiveEvent(parsed);
    });
  }
}
function setStreamState(text, kind) {
  const node = $("#activity-stream-state");
  node.className = `stream-state stream-${kind}`;
  node.replaceChildren(el("span", { className: "conn-dot", "aria-hidden": "true" }, "●"), text);
}
function onLiveEvent(ev) {
  activityEvents.unshift(ev);
  if (activityEvents.length > 500) activityEvents.length = 500;
  if (!activityPaused) renderActivity();
}

function renderActivity() {
  const list = $("#activity-list");
  const type = $("#activity-type").value;
  const shown = type ? activityEvents.filter((e) => e.type === type) : activityEvents;
  $("#activity-count").textContent = `${shown.length} event${shown.length === 1 ? "" : "s"}`;
  if (shown.length === 0) {
    list.replaceChildren(el("p", { className: "empty" }, "No activity yet — route an utterance or run a skill to see live events."));
    return;
  }
  list.replaceChildren(...shown.slice(0, 200).map(activityRow));
}

function activityRow(ev) {
  const row = el("div", { className: `act act-${ev.type}` });
  const head = el("div", { className: "act-head" },
    el("span", { className: `act-type act-type-${ev.type}` }, ev.type),
    el("span", { className: "act-ts mono" }, fmtTs(ev.ts)),
  );
  row.append(head);
  const d = ev.data ?? {};
  if (ev.type === "selection") {
    const s = d.selection ?? {};
    head.append(el("span", { className: "act-target mono" }, d.target ?? ""));
    row.append(el("p", { className: "act-line mono" },
      `${s.mode}${s.chosen ? " → " + s.chosen.slug + " (" + fmt(s.chosen.score) + ", " + s.chosen.tier + ")" : ""}${s.ambiguous ? " · ambiguous" : ""}`));
    if (d.tierDisabled) {
      // the selection SSE event carries tierDisabled as the string "semantic" (api.ts), but render
      // defensively so an object form {tier,reason} never prints "[object Object]".
      const td = typeof d.tierDisabled === "object" ? (d.tierDisabled.reason ?? d.tierDisabled.tier ?? "semantic") : d.tierDisabled;
      row.append(el("p", { className: "act-line warn mini" }, `tier disabled: ${td}`));
    }
    if (s.chosen?.id && d.conversationId) row.append(suppressControl(d.conversationId, s.chosen.id, s.chosen.slug));
  } else if (ev.type === "injection") {
    head.append(el("span", { className: "act-target mono" }, d.target ?? ""));
    if (d.sticky) head.append(el("span", { className: "sticky-badge" }, el("i", { className: "chip-icon", "aria-hidden": "true" }, "⇊"), "sticky / persisted"));
    row.append(el("p", { className: "act-line mono" },
      `${d.slug} · ${d.disclosure} · ${d.injectedBytes} B${typeof d.injectedChars === "number" ? " / " + d.injectedChars + " chars" : ""} · ${d.tokenCost} tok`));
    if (d.id && d.conversationId) row.append(suppressControl(d.conversationId, d.id, d.slug));
  } else if (ev.type === "exec") {
    const refused = d.exit === null;
    head.append(el("span", { className: `act-exit ${refused ? "exit-refused" : d.exit === 0 ? "exit-ok" : "exit-err"}` },
      refused ? "refused" : `exit ${d.exit}`));
    row.append(el("p", { className: "act-line mono" }, `${d.slug}${d.target ? " · " + d.target : ""} · ${d.durationMs}ms`));
    if ((d.argv ?? []).length) row.append(el("p", { className: "act-sub mono mini" }, `argv: ${d.argv.join(" ")}`));
    row.append(el("p", { className: "act-sub mono mini" }, `cwd: ${d.cwd}`));
    if (d.stdoutTail) row.append(el("pre", { className: "act-tail" }, d.stdoutTail));
    if (d.stderrTail) row.append(el("pre", { className: "act-tail act-tail-err" }, d.stderrTail));
    row.append(el("p", { className: "act-sub mono mini" }, `hash: ${d.contentHash || "—"}`));
  } else if (ev.type === "source") {
    row.append(el("p", { className: "act-line mono" }, `${d.sourceId} · ${d.status}${typeof d.changed === "number" ? " · " + d.changed + " changed" : ""}`));
  } else if (ev.type === "staleness") {
    row.append(el("p", { className: "act-line mono" }, `manifest seq ${d.manifestSeq} · daemon seq ${d.daemonSeq} · dbRevision ${d.dbRevision}`));
  }
  return row;
}

// "this skill is wrong → suppress for this conversation" (R1-B1), scoped to ONE skill in ONE conversation.
function suppressControl(conversationId, skillId, slug) {
  const key = `${conversationId}::${skillId}`;
  if (suppressedKeys.has(key)) return el("p", { className: "ok mini" }, `suppressed ${slug} for this conversation`);
  const btn = el("button", { type: "button", className: "linkish-danger small", onClick: () => doSuppress(conversationId, skillId, slug, btn) },
    `this skill is wrong → suppress ${slug} for this conversation`);
  return btn;
}
async function doSuppress(conversationId, skillId, slug, btn) {
  btn.disabled = true;
  try {
    await api("POST", `/conversations/${encodeURIComponent(conversationId)}/suppress`, { skillId, on: true });
    suppressedKeys.add(`${conversationId}::${skillId}`);
    btn.replaceWith(el("p", { className: "ok mini" }, `suppressed ${slug} for this conversation`));
    toast(`${slug} suppressed for this conversation.`, "ok");
  } catch (e) {
    btn.disabled = false;
    toast(`Could not suppress ${slug}: ${errMsg(e)}`, "err");
  }
}

// ════════════════════════════ Surface: Status / Settings ════════════════════════════
let currentConfig = null;
async function loadStatus() {
  await Promise.all([loadHealthPanel(), loadSettings()]);
}

async function loadHealthPanel() {
  const grid = $("#status-health");
  grid.setAttribute("aria-busy", "true");
  let h;
  try {
    h = await api("GET", "/health");
  } catch (e) {
    grid.setAttribute("aria-busy", "false");
    grid.replaceChildren(errorPanel(`Failed to load health: ${errMsg(e)}`, loadHealthPanel));
    return;
  }
  grid.setAttribute("aria-busy", "false");
  const cards = [];
  cards.push(statusCard("Daemon", h.ok ? "ok" : "err", h.ok ? "running" : "not ok",
    [`pid ${h.writerPid}`, `up ${fmtUptime(h.uptimeMs)}`]));
  cards.push(statusCard("LM Studio", h.lmStudioReachable ? "ok" : "err", h.lmStudioReachable ? "reachable" : "unreachable", []));
  cards.push(statusCard("Embeddings (Tier-2)", h.embeddingsReachable ? "ok" : "warn",
    h.embeddingsReachable ? "reachable" : "off / unreachable",
    h.embeddingsReachable ? [] : ["semantic routing disabled"]));
  cards.push(statusCard("Read-model", "info", `seq ${h.seq}`, [`dbRevision ${h.dbRevision}`]));
  // per-target liveness
  for (const t of TARGETS) {
    const live = h.targets?.[t];
    cards.push(statusCard(TARGET_LABEL[t], live?.live ? "ok" : "warn", live?.live ? "live" : "down", live?.reason ? [live.reason] : []));
  }
  grid.replaceChildren(...cards);
}
function statusCard(title, kind, state, lines) {
  return el("div", { className: `status-card status-${kind}` },
    el("h3", {}, title),
    el("p", { className: "status-state" },
      el("i", { className: "chip-icon", "aria-hidden": "true" }, kind === "ok" ? "✓" : kind === "err" ? "✕" : kind === "warn" ? "⚠" : "•"), state),
    ...lines.map((l) => el("p", { className: "dim mono mini" }, l)),
  );
}

async function loadSettings() {
  const wrap = $("#status-settings");
  wrap.setAttribute("aria-busy", "true");
  try {
    currentConfig = await api("GET", "/config");
  } catch (e) {
    wrap.setAttribute("aria-busy", "false");
    wrap.replaceChildren(errorPanel(`Failed to load settings: ${errMsg(e)}`, loadSettings));
    return;
  }
  wrap.setAttribute("aria-busy", "false");
  renderSettings();
}

function renderSettings() {
  const c = currentConfig;
  const wrap = $("#status-settings");
  const parts = [];

  // connection (lmStudioBaseUrl + port)
  const conn = settingsPanel("Connection", [
    field("lm-base", "LM Studio base URL", c.lmStudioBaseUrl ?? ""),
    field("port", "Control port (restart to apply)", String(c.port ?? ""), "number"),
  ], async () => {
    const patch = { lmStudioBaseUrl: $("#set-lm-base").value.trim() };
    const port = Number($("#set-port").value);
    if (Number.isInteger(port) && port >= 0 && port <= 65535) patch.port = port;
    await saveConfig(patch, "Connection saved.");
    await loadHealthPanel();
  });
  parts.push(conn);

  // embeddings provider — configured INDEPENDENTLY (M-embed). Visible Tier-2-disabled banner when absent.
  const emb = c.embeddings;
  const embPanel = el("div", { className: "panel" }, el("h3", {}, "Embeddings — Tier-2 semantic (configured independently)"));
  if (!emb) embPanel.append(banner("warn", "⚠", "Tier-2 semantic is DISABLED — no embeddings provider configured. Routing is lexical + explicit only."));
  embPanel.append(el("div", { className: "settings-fields" },
    field("emb-base", "Provider base URL", emb?.baseUrl ?? ""),
    field("emb-model", "Model", emb?.model ?? ""),
    field("emb-dim", "Dim", emb?.dim != null ? String(emb.dim) : "", "number"),
  ));
  const embStatus = el("span", { className: "save-status", role: "status", "aria-live": "polite" });
  const saveEmbBtn = el("button", { type: "button", className: "primary", onClick: () => runSave(saveEmbBtn, embStatus, saveEmbeddings) }, "Save embeddings");
  const disableEmbBtn = el("button", { type: "button", className: "danger", disabled: !emb,
    onClick: () => { if (confirm("Disable Tier-2 semantic routing (clear the embeddings provider)?")) runSave(disableEmbBtn, embStatus, disableEmbeddings); } }, "Disable Tier-2 (clear)");
  embPanel.append(el("div", { className: "settings-actions" }, saveEmbBtn, disableEmbBtn, embStatus));
  parts.push(embPanel);

  // chat upstreams (proxy adapter)
  const ups = c.upstreams ?? {};
  const upPanel = settingsPanel("Chat upstreams (proxy / per-target)",
    TARGETS.map((t) => field(`up-${t}`, `${TARGET_LABEL[t]} chat base URL`, ups[t]?.chatBaseUrl ?? "")),
    async () => {
      const upstreams = {};
      for (const t of TARGETS) {
        const v = $(`#set-up-${t}`).value.trim();
        if (v) upstreams[t] = { chatBaseUrl: v };
      }
      await saveConfig({ upstreams }, "Chat upstreams saved.");
      await loadHealthPanel();
    });
  parts.push(upPanel);

  wrap.replaceChildren(...parts);
}

function settingsPanel(title, fields, onSave) {
  const panel = el("div", { className: "panel" }, el("h3", {}, title));
  panel.append(el("div", { className: "settings-fields" }, ...fields));
  const status = el("span", { className: "save-status", role: "status", "aria-live": "polite" });
  const btn = el("button", { type: "button", className: "primary", onClick: () => runSave(btn, status, onSave) }, "Save");
  panel.append(el("div", { className: "settings-actions" }, btn, status));
  return panel;
}
function field(id, label, value, type = "text") {
  return el("label", { className: "set-field" },
    el("span", { className: "field-label" }, label),
    el("input", { id: `set-${id}`, type, value }),
  );
}

function setSaveStatus(node, kind, text) {
  if (!node) return;
  node.className = `save-status save-${kind}`;
  node.replaceChildren(el("i", { className: "chip-icon", "aria-hidden": "true" }, kind === "ok" ? "✓" : kind === "err" ? "✕" : "…"), text);
}
/** Run a settings save with a VISIBLE saving state + inline success/error (a 4xx/5xx is shown inline AND
 *  toasted, never silent). On success the panel usually re-renders (the button detaches — harmless). */
async function runSave(btn, status, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving…";
  setSaveStatus(status, "saving", "saving…");
  try {
    await fn();
    setSaveStatus(status, "ok", "saved");
  } catch (e) {
    setSaveStatus(status, "err", `failed: ${errMsg(e)}`);
    toast(errMsg(e), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function saveConfig(patch, okMsg) {
  currentConfig = await api("PATCH", "/config", patch);
  renderSettings();
  toast(okMsg, "ok");
}
async function saveEmbeddings() {
  const baseUrl = $("#set-emb-base").value.trim();
  const model = $("#set-emb-model").value.trim();
  const dim = Number($("#set-emb-dim").value);
  if (!baseUrl || !model || !Number.isFinite(dim) || dim <= 0) {
    throw new Error("Embeddings need a base URL, a model, and a positive dim."); // surfaced inline by runSave
  }
  await saveConfig({ embeddings: { baseUrl, model, dim } }, "Embeddings provider saved — Tier-2 enabled.");
  await loadHealthPanel();
}
async function disableEmbeddings() {
  await saveConfig({ embeddings: null }, "Tier-2 disabled — embeddings provider cleared.");
  await loadHealthPanel();
}

// ───────── shared render bits ─────────
function banner(kind, icon, text) {
  return el("div", { className: `banner banner-${kind}` }, el("span", { "aria-hidden": "true" }, icon), text);
}
function rowCells(cell, vals) { const tr = el("tr", {}); for (const v of vals) tr.append(el(cell, {}, v)); return tr; }
function errorPanel(message, retry) {
  const p = el("div", { className: "error-panel" },
    el("span", { className: "error-icon", "aria-hidden": "true" }, "✕"),
    el("span", {}, message));
  if (retry) p.append(el("button", { type: "button", className: "secondary small", onClick: retry }, "Retry"));
  return p;
}

// ───────── header connection badge (light poll) ─────────
async function pollHealth() {
  try {
    const h = await api("GET", "/health", undefined, { timeoutMs: 4000 });
    setConn(h.ok ? "live" : "degraded", h.ok ? "connected" : "degraded");
  } catch {
    setConn("offline", "daemon offline");
  }
}
function setConn(kind, label) {
  const node = $("#conn");
  node.className = `conn conn-${kind}`;
  $("#conn-label").textContent = label;
}

// ───────── boot ─────────
showView("skills");
loadSkills();
pollHealth();
setInterval(pollHealth, 20000);
