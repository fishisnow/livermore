const state = {
  sessionId: localStorage.getItem("livermore.sessionId") || "",
  sending: false,
  dashboard: null,
  positions: [],
  view: "chat",
  taskConfig: null,
  taskConfigDirty: false,
  selectedTask: null,
  chats: [],
  chatQuery: "",
  switchingChat: false,
};

const elements = {
  messages: document.querySelector("#messages"),
  welcome: document.querySelector("#welcome"),
  composer: document.querySelector("#composer"),
  prompt: document.querySelector("#prompt"),
  send: document.querySelector("#send"),
  tasks: document.querySelector("#tasks"),
  recentRuns: document.querySelector("#recent-runs"),
  capabilities: document.querySelector("#capabilities"),
  systemStatus: document.querySelector("#system-status"),
  toolActivity: document.querySelector("#tool-activity"),
  toolLabel: document.querySelector("#tool-label"),
  dialog: document.querySelector("#run-dialog"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogMeta: document.querySelector("#dialog-meta"),
  dialogEvaluations: document.querySelector("#dialog-evaluations"),
  dialogReport: document.querySelector("#dialog-report"),
  portfolioDialog: document.querySelector("#portfolio-dialog"),
  portfolioRows: document.querySelector("#portfolio-rows"),
  portfolioEmpty: document.querySelector("#portfolio-empty"),
  positionForm: document.querySelector("#position-form"),
  capabilityDialog: document.querySelector("#capability-dialog"),
  skillLedger: document.querySelector("#skill-ledger"),
  mcpLedger: document.querySelector("#mcp-ledger"),
  mcpForm: document.querySelector("#mcp-form"),
  connectionLedger: document.querySelector("#connection-ledger"),
  toolLedger: document.querySelector("#tool-ledger"),
  toast: document.querySelector("#toast"),
  traceLink: document.querySelector("#trace-link"),
  notifications: document.querySelector("#notification-list"),
  notificationDialog: document.querySelector("#notification-dialog"),
  taskConfigDialog: document.querySelector("#task-config-dialog"),
};

// The same workspace runs in WebKit and in a browser; native integration is optional.
const nativeBridge = window.webkit?.messageHandlers?.livermore;
document.body.classList.toggle("is-desktop", Boolean(window.livermoreDesktop));
const systemAppearance = matchMedia("(prefers-color-scheme: dark)");
let appearance = localStorage.getItem("livermore.appearance") || window.livermoreInitialAppearance || "system";
function setAppearance(value) {
  appearance = ["system", "light", "dark"].includes(value) ? value : "system";
  localStorage.setItem("livermore.appearance", appearance);
  document.documentElement.dataset.theme = appearance === "system" ? (systemAppearance.matches ? "dark" : "light") : appearance;
  document.querySelector("#appearance").value = appearance;
  nativeBridge?.postMessage({ type: "appearance", value: appearance });
}
systemAppearance.addEventListener("change", () => { if (appearance === "system") setAppearance("system"); });
document.querySelector("#appearance").addEventListener("change", (event) => setAppearance(event.target.value));
setAppearance(appearance);
function setMoyu(enabled) {
  document.documentElement.dataset.moyu = enabled ? "on" : "off";
  localStorage.setItem("livermore.moyu", enabled ? "on" : "off");
  const button = document.querySelector("#moyu-mode");
  button.setAttribute("aria-pressed", String(enabled));
}
document.querySelector("#moyu-mode").addEventListener("click", () => setMoyu(document.documentElement.dataset.moyu !== "on"));
setMoyu(localStorage.getItem("livermore.moyu") === "on");
document.documentElement.dataset.sidebar = localStorage.getItem("livermore.sidebar") || "expanded";
document.body.dataset.inspector = localStorage.getItem("livermore.inspector") || "auto";
const compactWindow = matchMedia("(max-width: 1180px)");
function syncInspector() {
  const mode = document.body.dataset.inspector;
  document.querySelector("#toggle-inspector").setAttribute("aria-expanded", String(mode === "open" || (mode === "auto" && !compactWindow.matches)));
}
function toggleInspector() {
  // Read layout instead of a cached ARIA value: resize events can arrive after a click.
  const open = document.querySelector(".task-rail").getClientRects().length > 0;
  document.body.dataset.inspector = open ? "closed" : "open";
  localStorage.setItem("livermore.inspector", document.body.dataset.inspector);
  syncInspector();
}
function toggleSidebar() {
  const next = document.documentElement.dataset.sidebar === "collapsed" ? "expanded" : "collapsed";
  document.documentElement.dataset.sidebar = next;
  localStorage.setItem("livermore.sidebar", next);
  closeHistoryMenu();
}
compactWindow.addEventListener("change", syncInspector);
syncInspector();
document.querySelector("#toggle-sidebar").addEventListener("click", toggleSidebar);
document.querySelector("#sidebar-collapse").addEventListener("click", toggleSidebar);
document.querySelector("#toggle-inspector").addEventListener("click", toggleInspector);
document.querySelector(".conversation").addEventListener("pointerdown", () => {
  if (compactWindow.matches && document.body.dataset.inspector === "open") toggleInspector();
});
document.querySelector("#native-settings").addEventListener("click", () => nativeBridge?.postMessage({ type: "settings" }));
const views = {
  chat: ["研究对话", "与你的本地投资 Agent 一起研究"],
  portfolio: ["我的持仓", "持仓维护 · 风险监测 · 操作建议"],
  tasks: ["定时任务", "选择任务后，只显示该任务的运行记录"],
  charts: ["", ""],
  capabilities: ["研究能力", "已安装的 Skills、MCP 与数据连接"],
};
const chartState = { fearGreed: null, fearGreedRange: 366, equityBond: null, equityIndex: "881001.WI", equityPe: "fed", equityRange: 366 * 5, nationalTeam: null, nationalRange: 21, riseFall: null, expandedChart: null };
const EQUITY_BOND_CHOICES = [["881001.WI", "万得全A"], ["000300.SH", "沪深300"], ["000905.SH", "中证500"], ["000016.SH", "上证50"]];
const EQUITY_BOND_METHODS = [["fed", "FED"], ["gxl", "股息率"]];
// Reuse the existing functional panels without modal nesting or duplicate controls.
for (const panel of [elements.portfolioDialog, elements.capabilityDialog]) {
  panel.classList.add("workspace-panel");
  panel.tabIndex = -1;
  document.querySelector(".workspace").append(panel);
}
async function setView(view, { refresh = false } = {}) {
  if (!views[view]) return;
  state.view = view;
  document.body.dataset.view = view;
  if (view !== "chat") closeHistoryMenu();
  document.querySelector("#view-title").textContent = views[view][0];
  document.querySelector("#view-subtitle").textContent = views[view][1];
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    const selected = button.dataset.viewTarget === view;
    button.classList.toggle("selected", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  for (const [name, panel] of [["portfolio", elements.portfolioDialog], ["capabilities", elements.capabilityDialog]]) {
    if (view === name && !panel.open) { panel.show(); panel.focus({ preventScroll: true }); }
    else if (view !== name && panel.open) panel.close();
  }
  if (view === "portfolio") {
    if (!document.querySelector("#position-purchased-at").value) document.querySelector("#position-purchased-at").value = toDateTimeLocal(new Date());
    await loadPortfolio();
  } else if (view === "capabilities") await loadCapabilities(refresh);
  else if (view === "charts") await loadCharts();
  if (view !== "charts" && chartState.expandedChart) {
    chartState.expandedChart = null;
    const backdrop = document.querySelector("#chart-expand-backdrop");
    if (backdrop) backdrop.hidden = true;
  }
}
document.querySelectorAll("[data-view-target]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.viewTarget)));
document.querySelector("#chart-expand-backdrop").addEventListener("click", () => {
  if (chartState.expandedChart) toggleChartExpand(chartState.expandedChart);
});
document.querySelector("#chart-grid").addEventListener("click", (event) => {
  const expand = event.target.closest("[data-chart-expand]");
  if (expand) { toggleChartExpand(expand.closest(".chart-panel")?.id); return; }
  if (event.target.closest("[data-refresh-charts]")) { loadCharts(); return; }
  const fear = event.target.closest("[data-fear-range]");
  if (fear && chartState.fearGreed) {
    chartState.fearGreedRange = Number(fear.dataset.fearRange);
    renderFearGreedPanel();
    return;
  }
  const flow = event.target.closest("[data-flow-range]");
  if (flow && chartState.nationalTeam) {
    chartState.nationalRange = Number(flow.dataset.flowRange);
    renderNationalTeamPanel();
    return;
  }
  const equityRange = event.target.closest("[data-equity-range]");
  if (equityRange && chartState.equityBond) {
    chartState.equityRange = Number(equityRange.dataset.equityRange);
    renderEquityBondPanel();
    return;
  }
  const equityIndex = event.target.closest("[data-equity-index]");
  if (equityIndex && equityIndex.dataset.equityIndex !== chartState.equityIndex) {
    chartState.equityIndex = equityIndex.dataset.equityIndex;
    loadEquityBondChart();
    return;
  }
  const equityMethod = event.target.closest("[data-equity-pe]");
  if (equityMethod && equityMethod.dataset.equityPe !== chartState.equityPe) {
    chartState.equityPe = equityMethod.dataset.equityPe;
    loadEquityBondChart();
  }
});
document.querySelector("#chart-grid").addEventListener("pointerdown", startChartResize);
document.querySelector("#chart-grid").addEventListener("pointermove", (event) => {
  if (chartResize) return;
  if (event.target.closest(".equity-chart")) { showFearGreedCursor(null); showFlowCursor(null); moveEquityCursor(event); return; }
  if (event.target.closest(".fear-chart")) { showEquityCursor(null); showFlowCursor(null); moveFearGreedCursor(event); return; }
  if (event.target.closest(".flow-chart")) { showEquityCursor(null); showFearGreedCursor(null); moveFlowCursor(event); return; }
  showEquityCursor(null);
  showFearGreedCursor(null);
  showFlowCursor(null);
});
document.querySelector("#chart-grid").addEventListener("pointerleave", () => {
  if (chartResize) return;
  showEquityCursor(null);
  showFearGreedCursor(null);
  showFlowCursor(null);
});
function newConversation() {
  if (state.sending || state.switchingChat) { showToast("请等待当前对话操作完成后再开始新对话"); return; }
  state.sessionId = "";
  localStorage.removeItem("livermore.sessionId");
  elements.messages.replaceChildren(elements.welcome);
  elements.welcome.hidden = false;
  elements.prompt.value = ""; autoSize();
  document.querySelector("#chat-session-title").textContent = "研究会话";
  loadChatHistory();
  setView("chat");
  elements.prompt.focus();
}
window.livermoreUI = { setAppearance, setView, toggleSidebar, toggleInspector, newConversation, openNotification, notificationStatus, openTaskConfig, openChat, openNewTaskConfig };
nativeBridge?.postMessage({ type: "notification-status" });
document.addEventListener("keydown", (event) => {
  if (event.metaKey && !event.altKey && !event.shiftKey) {
    if (event.key.toLowerCase() === "n") { event.preventDefault(); newConversation(); }
    const view = ["chat", "portfolio", "tasks", "capabilities"][Number(event.key) - 1];
    if (view) { event.preventDefault(); setView(view); }
  }
  if (event.key === "Escape" && historyMenuId) { event.preventDefault(); closeHistoryMenu(); return; }
  if (event.key === "Escape" && !document.querySelector("#appearance-menu").hidden) { event.preventDefault(); document.querySelector("#appearance-menu").hidden = true; document.querySelector("#appearance-button").setAttribute("aria-expanded", "false"); return; }
  if (event.key === "Escape" && chartState.expandedChart && !document.querySelector("dialog[open]")) { event.preventDefault(); toggleChartExpand(chartState.expandedChart); return; }
  if (event.key === "Escape" && state.view === "chat" && compactWindow.matches && document.body.dataset.inspector === "open" && !elements.dialog.open) toggleInspector();
});

document.querySelector("#clock").textContent = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
}).format(new Date());

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(elements.prompt.value);
});

elements.prompt.addEventListener("input", autoSize);
elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => sendMessage(button.dataset.prompt));
});

document.querySelector("#new-session").addEventListener("click", newConversation);
document.querySelector("#sidebar-new").addEventListener("click", newConversation);

document.querySelector("#refresh").addEventListener("click", loadDashboard);
document.querySelector("#refresh-tasks").addEventListener("click", loadDashboard);
document.querySelector("#new-research-task").addEventListener("click", openNewTaskConfig);
document.querySelector("#delete-custom-task").addEventListener("click", deleteCustomTask);
document.querySelector("#more-chats").addEventListener("click", () => loadChatHistory(true));
document.querySelector("#history-search-toggle").addEventListener("click", () => {
  const box = document.querySelector("#history-search");
  box.hidden = !box.hidden;
  document.querySelector("#history-search-toggle").setAttribute("aria-expanded", String(!box.hidden));
  if (box.hidden) {
    state.chatQuery = "";
    document.querySelector("#history-query").value = "";
    renderChatHistory();
  } else document.querySelector("#history-query").focus();
});
document.querySelector("#history-query").addEventListener("input", (event) => {
  state.chatQuery = event.target.value;
  renderChatHistory();
});
document.querySelector("#appearance-button").addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = document.querySelector("#appearance-menu");
  menu.hidden = !menu.hidden;
  document.querySelector("#appearance-button").setAttribute("aria-expanded", String(!menu.hidden));
  const value = document.querySelector("#appearance").value;
  menu.querySelectorAll("[data-appearance]").forEach((button) => button.setAttribute("aria-checked", String(button.dataset.appearance === value)));
});
document.querySelector("#appearance-menu").addEventListener("click", (event) => {
  const button = event.target.closest("[data-appearance]");
  if (!button) return;
  const select = document.querySelector("#appearance");
  select.value = button.dataset.appearance;
  select.dispatchEvent(new Event("change"));
  document.querySelector("#appearance-menu").hidden = true;
  document.querySelector("#appearance-button").setAttribute("aria-expanded", "false");
});
document.querySelector("#chat-history-list").addEventListener("click", (event) => {
  const more = event.target.closest("[data-chat-menu]");
  if (more) {
    event.stopPropagation();
    if (historyMenuId === more.dataset.chatMenu) closeHistoryMenu();
    else openHistoryMenu(more);
    return;
  }
  closeHistoryMenu();
  const open = event.target.closest("[data-chat-id]");
  if (open) openChat(open.dataset.chatId);
});
document.querySelector("#history-delete").addEventListener("click", () => {
  const id = historyMenuId;
  closeHistoryMenu();
  if (id) deleteChat(id);
});
document.querySelector(".chat-history").addEventListener("scroll", closeHistoryMenu, { passive: true });
document.addEventListener("click", (event) => {
  if (!event.target.closest("#history-menu") && !event.target.closest("[data-chat-menu]")) closeHistoryMenu();
  if (!event.target.closest("#appearance-menu") && event.target.id !== "appearance-button" && !event.target.closest("#appearance-button")) {
    document.querySelector("#appearance-menu").hidden = true;
    document.querySelector("#appearance-button").setAttribute("aria-expanded", "false");
  }
});
document.querySelector("#notification-permission").addEventListener("click", () => nativeBridge?.postMessage({ type: "notification-permission" }));
document.querySelector("#close-notification").addEventListener("click", () => elements.notificationDialog.close());
document.querySelector("#task-config-form").addEventListener("submit", saveTaskConfig);
document.querySelector("#task-config-form").addEventListener("input", () => { state.taskConfigDirty = true; });
document.querySelector("#close-task-config").addEventListener("click", closeTaskConfig);
elements.taskConfigDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeTaskConfig(); });
document.querySelector("#add-task-time").addEventListener("click", () => { appendTaskTime("09:00", state.taskConfig?.modes[0]); state.taskConfigDirty = true; });
document.querySelector("#reset-task-prompt").addEventListener("click", () => { if (state.taskConfig && confirm("恢复默认 Prompt？当前未保存的 Prompt 将被替换。")) { document.querySelector("#task-prompt").value = state.taskConfig.defaultPrompt; state.taskConfigDirty = true; } });
document.querySelector("#view-all-runs").addEventListener("click", () => {
  state.selectedTask = null;
  if (state.dashboard) renderDashboard(state.dashboard);
});
document.querySelector("#close-dialog").addEventListener("click", () => elements.dialog.close());
document.querySelector("#portfolio-open").addEventListener("click", openPortfolio);
document.querySelector("#close-portfolio-dialog").addEventListener("click", () => setView("chat"));
document.querySelector("#position-form").addEventListener("submit", savePosition);
document.querySelector("#cancel-position-edit").addEventListener("click", resetPositionForm);
document.querySelector("#run-portfolio-check").addEventListener("click", runPortfolioCheck);
document.querySelector("#atr-stop-multiplier").addEventListener("change", saveAtrMultiplier);
document.querySelector("#capability-details").addEventListener("click", () => openCapabilities(true));
document.querySelector("#close-capability-dialog").addEventListener("click", () => setView("chat"));
document.querySelector("#refresh-capabilities").addEventListener("click", () => openCapabilities(true));
document.querySelector("#add-mcp").addEventListener("click", () => openMcpForm());
document.querySelector("#cancel-mcp").addEventListener("click", closeMcpForm);
elements.mcpForm.addEventListener("submit", saveMcp);
elements.mcpLedger.addEventListener("change", onMcpChange);
elements.mcpLedger.addEventListener("click", onMcpClick);

loadDashboard();
loadPortfolio();
restoreConversation();
setInterval(loadDashboard, 12_000);

async function loadDashboard() {
  try {
    const response = await fetch("/api/dashboard");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.dashboard = await response.json();
    renderDashboard(state.dashboard);
    await loadNotifications();
    const { provider, model } = state.dashboard.agent;
    elements.systemStatus.textContent = `${provider} · ${model.split("/").filter(Boolean).at(-1)}`;
    elements.systemStatus.title = `${provider} / ${model}`;
    document.body.dataset.connection = "ready";
  } catch (error) {
    document.body.dataset.connection = "error";
    elements.systemStatus.textContent = "本地服务连接异常";
    console.error(error);
  }
}

const CHART_PANEL_DEFAULT = { width: 480, height: 300 };
let chartResize = null;
let chartResizeFrame = 0;

function readChartSizes() {
  try { return JSON.parse(localStorage.getItem("livermore.chartSizes") || "{}"); }
  catch { return {}; }
}

function chartPanelSize(id) {
  const saved = readChartSizes()[id];
  const fallback = id === "equity-bond-panel" ? { width: 520, height: 360 } : id === "rise-fall-panel" ? { width: 400, height: 380 } : CHART_PANEL_DEFAULT;
  const width = Number(saved?.width);
  const height = Number(saved?.height);
  return {
    width: Number.isFinite(width) ? width : fallback.width,
    height: Number.isFinite(height) ? height : fallback.height,
  };
}

function chartPanelBox(id, body) {
  const size = chartPanelSize(id);
  const expanded = chartState.expandedChart === id;
  const icon = expanded ? "i-collapse" : "i-expand";
  const label = expanded ? "还原图表" : "放大图表";
  return `<article class="chart-panel${expanded ? " expanded" : ""}" id="${id}" style="width:${size.width}px;height:${size.height}px">${body}<button class="icon-button chart-expand" type="button" data-chart-expand aria-pressed="${expanded}" aria-label="${label}"><svg class="icon"><use href="#${icon}"/></svg></button><span class="chart-panel-size">${size.width} × ${size.height}</span><button class="chart-resize" type="button" data-chart-resize aria-label="拖动调整图表大小"></button></article>`;
}

function syncChartPanelMetric(panel) {
  const label = panel?.querySelector(".chart-panel-size");
  if (!label) return;
  label.textContent = `${panel.offsetWidth} × ${panel.offsetHeight}`;
}

function toggleChartExpand(id) {
  if (!id) return;
  chartState.expandedChart = chartState.expandedChart === id ? null : id;
  const backdrop = document.querySelector("#chart-expand-backdrop");
  if (backdrop) backdrop.hidden = chartState.expandedChart === null;
  if (id === "fear-greed-panel" && chartState.fearGreed?.latest) renderFearGreedPanel();
  else if (id === "equity-bond-panel" && chartState.equityBond?.latest) renderEquityBondPanel();
  else if (id === "national-team-panel" && chartState.nationalTeam?.latest) renderNationalTeamPanel();
  else if (id === "rise-fall-panel" && chartState.riseFall?.success) renderRiseFallPanel();
  else {
    const panel = document.getElementById(id);
    if (!panel) return;
    const expanded = chartState.expandedChart === id;
    panel.classList.toggle("expanded", expanded);
    const button = panel.querySelector("[data-chart-expand]");
    button?.setAttribute("aria-pressed", String(expanded));
    button?.setAttribute("aria-label", expanded ? "还原图表" : "放大图表");
    button?.querySelector("use")?.setAttribute("href", expanded ? "#i-collapse" : "#i-expand");
    syncChartPanelMetric(panel);
  }
}

function saveChartPanelSize(id, width, height) {
  const sizes = readChartSizes();
  sizes[id] = { width: Math.round(width), height: Math.round(height) };
  localStorage.setItem("livermore.chartSizes", JSON.stringify(sizes));
}

function startChartResize(event) {
  const handle = event.target.closest("[data-chart-resize]");
  if (!handle || chartResize || handle.closest(".chart-panel")?.classList.contains("expanded")) return;
  event.preventDefault();
  const panel = handle.closest(".chart-panel");
  chartResize = {
    panel,
    startX: event.clientX,
    startY: event.clientY,
    width: panel.offsetWidth,
    height: panel.offsetHeight,
  };
  panel.classList.add("resizing");
  document.body.classList.add("chart-resizing");
  document.addEventListener("pointermove", moveChartResize);
  document.addEventListener("pointerup", endChartResize);
  document.addEventListener("pointercancel", endChartResize);
}

function moveChartResize(event) {
  if (!chartResize) return;
  const grid = document.querySelector("#chart-grid");
  const maxWidth = Math.max(320, grid.clientWidth);
  const width = Math.min(maxWidth, Math.max(320, chartResize.width + event.clientX - chartResize.startX));
  const height = Math.min(760, Math.max(220, chartResize.height + event.clientY - chartResize.startY));
  chartResize.panel.style.width = `${Math.round(width)}px`;
  chartResize.panel.style.height = `${Math.round(height)}px`;
  syncChartPanelMetric(chartResize.panel);
  cancelAnimationFrame(chartResizeFrame);
  chartResizeFrame = requestAnimationFrame(() => layoutResizedChart(chartResize?.panel));
}

function endChartResize() {
  if (!chartResize) return;
  const panel = chartResize.panel;
  panel.classList.remove("resizing");
  document.body.classList.remove("chart-resizing");
  saveChartPanelSize(panel.id, panel.offsetWidth, panel.offsetHeight);
  chartResize = null;
  document.removeEventListener("pointermove", moveChartResize);
  document.removeEventListener("pointerup", endChartResize);
  document.removeEventListener("pointercancel", endChartResize);
  layoutResizedChart(panel);
}

function layoutResizedChart(panel) {
  if (panel?.id === "national-team-panel") layoutFlowChart();
  else if (panel?.id === "equity-bond-panel") layoutEquityBondChart();
  else layoutFearGreedChart();
}

function mountChartPanel(html) {
  const holder = document.createElement("template");
  holder.innerHTML = html.trim();
  const next = holder.content.firstElementChild;
  if (!next) return;
  const current = document.getElementById(next.id);
  if (current) current.replaceWith(next);
  else document.querySelector("#chart-grid").append(next);
}

async function loadCharts() {
  const grid = document.querySelector("#chart-grid");
  grid.innerHTML = `${chartPanelBox("rise-fall-panel", `<p class="chart-empty">正在读取大A涨跌家数…</p>`)}${chartPanelBox("fear-greed-panel", `<p class="chart-empty">正在读取韭圈恐贪指数…</p>`)}${chartPanelBox("equity-bond-panel", `<p class="chart-empty">正在读取股债性价比…</p>`)}${chartPanelBox("national-team-panel", `<p class="chart-empty">正在汇总国家队宽基 ETF 净买卖…</p>`)}`;
  await Promise.all([loadRiseFallChart(), loadFearGreedChart(), loadEquityBondChart(), loadNationalTeamChart()]);
}

async function loadFearGreedChart() {
  try {
    const response = await fetch("/api/charts/fear-greed");
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || data.error || `HTTP ${response.status}`);
    chartState.fearGreed = data;
    renderFearGreedPanel();
  } catch (error) {
    mountChartPanel(chartPanelBox("fear-greed-panel", `<header class="chart-panel-head"><div><p class="eyebrow">韭圈儿</p><h3>恐贪指数</h3></div></header><p class="chart-empty">${escapeHtml(error.message)}</p>`));
  }
}

async function loadEquityBondChart() {
  const index = chartState.equityIndex;
  const method = chartState.equityPe;
  try {
    const response = await fetch(`/api/charts/equity-bond?index=${encodeURIComponent(index)}&pe=${encodeURIComponent(method)}`);
    const data = await response.json();
    if (index !== chartState.equityIndex || method !== chartState.equityPe) return;
    if (!response.ok || !data.success) throw new Error(data.message || data.error || `HTTP ${response.status}`);
    chartState.equityBond = data;
    renderEquityBondPanel();
  } catch (error) {
    if (index !== chartState.equityIndex || method !== chartState.equityPe) return;
    mountChartPanel(chartPanelBox("equity-bond-panel", `<header class="chart-panel-head"><div><p class="eyebrow">韭圈儿</p><h3>股债性价比</h3></div></header><p class="chart-empty">${escapeHtml(error.message)}</p>`));
  }
}

async function loadNationalTeamChart() {
  try {
    const response = await fetch("/api/charts/national-team");
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || data.error || `HTTP ${response.status}`);
    chartState.nationalTeam = data;
    renderNationalTeamPanel();
  } catch (error) {
    mountChartPanel(chartPanelBox("national-team-panel", `<header class="chart-panel-head"><div><p class="eyebrow">宽基 ETF</p><h3>国家队净买卖</h3></div></header><p class="chart-empty">${escapeHtml(error.message)}</p>`));
  }
}

async function loadRiseFallChart() {
  try {
    const response = await fetch("/api/charts/rise-fall");
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || data.error || `HTTP ${response.status}`);
    chartState.riseFall = data;
    renderRiseFallPanel();
  } catch (error) {
    mountChartPanel(chartPanelBox("rise-fall-panel", `<header class="chart-panel-head"><div><p class="eyebrow">富途 · 沪深 A 股</p><h3>涨跌家数</h3></div></header><p class="chart-empty">${escapeHtml(error.message)}</p>`));
  }
}

function renderRiseFallPanel() {
  const data = chartState.riseFall;
  if (!data?.success) return;
  const count = (value) => Number(value).toLocaleString("zh-CN");
  mountChartPanel(chartPanelBox("rise-fall-panel", `
      <header class="chart-panel-head">
        <div><p class="eyebrow">富途 · 沪深 A 股</p><h3>涨跌家数</h3></div>
        <div class="chart-panel-tools">
          <time>${escapeHtml(data.date || "")}</time>
          <button class="icon-button" type="button" data-refresh-charts aria-label="刷新图表">↻</button>
        </div>
      </header>
      <div class="rise-fall-stage">${riseFallDonut(data)}</div>
      <p class="rise-fall-legend"><span>上涨 <b>${count(data.rise)}</b></span><span>下跌 <b>${count(data.fall)}</b></span><span>平盘 <b>${count(data.flat)}</b></span><span>涨停 <b>${count(data.limitUp)}</b></span><span>跌停 <b>${count(data.limitDown)}</b></span></p>`));
}

function riseFallDonut(data) {
  const rise = Number(data.rise) || 0;
  const fall = Number(data.fall) || 0;
  const flat = Number(data.flat) || 0;
  const total = rise + fall + flat;
  const radius = 68;
  const circumference = 2 * Math.PI * radius;
  const parts = [
    { value: rise, kind: "rise" },
    { value: flat, kind: "flat" },
    { value: fall, kind: "fall" },
  ].filter((part) => part.value > 0);
  let cursor = 0;
  const arcs = parts.map((part) => {
    const length = total > 0 ? (part.value / total) * circumference : 0;
    const arc = `<circle class="rise-fall-${part.kind}" cx="100" cy="100" r="${radius}" fill="none" stroke-width="24" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-cursor}"/>`;
    cursor += length;
    return arc;
  }).join("");
  const percent = rise + fall > 0 ? `${Math.round(Number(data.heat) * 100)}%` : "—";
  return `<svg class="rise-fall-chart" viewBox="0 0 200 200" role="img" aria-label="上涨 ${rise} 家，下跌 ${fall} 家，平盘 ${flat} 家"><g transform="rotate(-90 100 100)">${arcs}</g><text class="rise-fall-percent" x="100" y="96" text-anchor="middle">${percent}</text><text class="rise-fall-caption" x="100" y="116" text-anchor="middle">上涨占比</text></svg>`;
}

function renderFearGreedPanel() {
  const data = chartState.fearGreed;
  const latest = data?.latest;
  if (!latest) return;
  chartState.fearGreedWindow = fearGreedWindow(data.points, chartState.fearGreedRange);
  const ranges = [[92, "3 个月"], [366, "1 年"], [0, "全部"]];
  mountChartPanel(chartPanelBox("fear-greed-panel", `
      <header class="chart-panel-head">
        <div><p class="eyebrow">韭圈儿</p><h3>恐贪指数</h3></div>
        <div class="chart-panel-tools">
          <div class="chart-ranges">${ranges.map(([days, label]) => `<button type="button" data-fear-range="${days}" class="${days === chartState.fearGreedRange ? "selected" : ""}">${label}</button>`).join("")}</div>
          <button class="icon-button" type="button" data-refresh-charts aria-label="刷新图表">↻</button>
        </div>
      </header>
      <div class="fear-readout ${escapeHtml(latest.band)}">
        <strong>${latest.value.toFixed(1)}</strong>
        <span>${escapeHtml(latest.label)}</span>
        <time>${escapeHtml(latest.date)}</time>
      </div>
      ${fearGreedGauge(latest.value)}
      <p class="fear-note">${escapeHtml(latest.note)}</p>
      <div class="fear-chart-wrap"></div>`));
  layoutFearGreedChart();
}

function renderEquityBondPanel() {
  const data = chartState.equityBond;
  const latest = data?.latest;
  if (!latest) return;
  chartState.equityWindow = fearGreedWindow(data.points, chartState.equityRange);
  const ranges = [[366, "1 年"], [366 * 5, "5 年"], [0, "10 年"]];
  const bond = data.bond;
  const temperature = data.temperature;
  const facts = [
    bond ? `<span>十年期国债 <b>${bond.yield.toFixed(2)}%</b></span>` : "",
    bond?.temperature != null ? `<span>债温 <b>${formatTemperature(bond.temperature)}</b></span>` : "",
    temperature ? `<span>万得全A股温 <b>${formatTemperature(temperature.value)}</b></span>` : "",
  ].filter(Boolean).join("");
  const factTitle = [
    bond ? `十年期国债取 ${bond.date} 的最新收益率，不随指数、口径和鼠标变化。` : "",
    bond?.temperature != null ? "债温越高，国债收益率处在历史越低的位置，债券越贵。" : "",
    temperature ? `股温只统计万得全A，数值越低表示股市越低估。${temperature.summary}` : "",
  ].filter(Boolean).join("");
  const note = data.peCategory === "fed"
    ? "FED 风险溢价是股票盈利收益率减去十年期国债收益率，公式是 1/市盈率 − 国债收益率。数值越高，说明股票相对债券越便宜。"
    : "溢价越高，股票相对债券越便宜。";
  const formula = data.formula ? `<span class="equity-info-formula">${escapeHtml(data.formula)}</span>` : "";
  const title = `<h3 class="equity-title"><span>${escapeHtml(data.peLabel)}</span><span class="equity-info"><button type="button" aria-label="${escapeHtml(data.peLabel)}说明"><svg class="equity-info-mark" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 8h.01"/></svg></button><span class="equity-info-tip"><span class="equity-info-note">${escapeHtml(note)}</span>${formula}</span></span></h3>`;
  mountChartPanel(chartPanelBox("equity-bond-panel", `
      <header class="chart-panel-head equity-head">
        <div class="equity-head-row">
          <div><p class="eyebrow">韭圈儿 · ${escapeHtml(data.indexName)}</p>${title}</div>
          <div class="chart-panel-tools">
            <div class="chart-ranges">${ranges.map(([days, label]) => `<button type="button" data-equity-range="${days}" class="${days === chartState.equityRange ? "selected" : ""}">${label}</button>`).join("")}</div>
            <button class="icon-button" type="button" data-refresh-charts aria-label="刷新图表">↻</button>
          </div>
        </div>
        ${facts ? `<p class="equity-snapshot" title="${escapeHtml(factTitle)}">${facts}</p>` : ""}
      </header>
      <div class="chart-switches">
        <div class="chart-switch"><span>指数</span><div class="chart-ranges">${EQUITY_BOND_CHOICES.map(([code, label]) => `<button type="button" data-equity-index="${code}" class="${code === chartState.equityIndex ? "selected" : ""}">${label}</button>`).join("")}</div></div>
        <div class="chart-switch"><span>口径</span><div class="chart-ranges">${EQUITY_BOND_METHODS.map(([method, label]) => `<button type="button" data-equity-pe="${method}" class="${method === chartState.equityPe ? "selected" : ""}">${label}</button>`).join("")}</div></div>
      </div>
      <div class="fear-readout equity-readout ${escapeHtml(latest.band)}">
        <strong>${latest.value.toFixed(2)}%</strong>
        <span>${escapeHtml(latest.label)}</span>
        <em>${latest.percentile == null ? "" : `近10年分位 ${latest.percentile.toFixed(1)}%`}</em>
        <time>${escapeHtml(latest.date)}</time>
      </div>
      <p class="equity-note">${escapeHtml(latest.note)}</p>
      <div class="fear-chart-wrap"></div>`));
  layoutEquityBondChart();
}

function formatTemperature(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function renderNationalTeamPanel() {
  const data = chartState.nationalTeam;
  const latest = data?.latest;
  if (!latest) return;
  chartState.flowWindow = flowWindow(data.points, chartState.nationalRange);
  const ranges = [[21, "1 个月"], [63, "3 个月"], [0, "1 年"]];
  const tone = latest.label === "净买入" ? "buy" : latest.label === "净卖出" ? "sell" : "flat";
  mountChartPanel(chartPanelBox("national-team-panel", `
      <header class="chart-panel-head">
        <div><p class="eyebrow">宽基 ETF</p><h3>国家队净买卖</h3></div>
        <div class="chart-panel-tools">
          <div class="chart-ranges">${ranges.map(([count, label]) => `<button type="button" data-flow-range="${count}" class="${count === chartState.nationalRange ? "selected" : ""}">${label}</button>`).join("")}</div>
          <button class="icon-button" type="button" data-refresh-charts aria-label="刷新图表">↻</button>
        </div>
      </header>
      <div class="fear-readout flow-readout ${tone}">
        <strong>${formatYi(latest.value)}</strong>
        <span>亿元</span>
        <em>${escapeHtml(latest.label)}</em>
        <time>${escapeHtml(latest.date)}</time>
      </div>
      <p class="fear-note">份额变化 × 当日净值</p>
      <div class="fear-chart-wrap"></div>`));
  layoutFlowChart();
}

function flowWindow(points, count) {
  if (!count || points.length <= count) return points;
  return points.slice(-count);
}

function formatYi(value, digits = 1) {
  if (!value) return "0";
  const text = Math.abs(value).toFixed(digits);
  return value > 0 ? `+${text}` : `-${text}`;
}

function moveFlowCursor(event) {
  const svg = event.target.closest(".flow-chart");
  const points = chartState.flowWindow;
  if (!svg || !points?.length || chartResize) { showFlowCursor(null); return; }
  const view = svg.viewBox.baseVal;
  if (!view.width || !view.height) return;
  const metrics = flowChartMetrics(points, view.width, view.height);
  const rect = svg.getBoundingClientRect();
  const viewX = (event.clientX - rect.left) / rect.width * metrics.width;
  if (viewX < metrics.left || viewX > metrics.left + metrics.plotW) { showFlowCursor(null); return; }
  const index = points.length === 1 ? 0 : Math.round((viewX - metrics.left) / metrics.plotW * (points.length - 1));
  showFlowCursor(points[index], index, metrics);
}

function showFlowCursor(point, index, metrics) {
  const panel = document.querySelector("#national-team-panel");
  const readout = panel?.querySelector(".flow-readout");
  const crosshair = panel?.querySelector(".fear-crosshair");
  const hover = panel?.querySelector(".fear-hover");
  const tooltip = panel?.querySelector(".fear-tooltip");
  const latest = chartState.nationalTeam?.latest;
  const shown = point || latest;
  if (!readout || !shown) return;
  const tone = shown.label === "净买入" ? "buy" : shown.label === "净卖出" ? "sell" : "flat";
  readout.className = `fear-readout flow-readout ${tone}`;
  readout.querySelector("strong").textContent = formatYi(shown.value);
  readout.querySelector("em").textContent = shown.label;
  readout.querySelector("time").textContent = shown.date;
  if (!crosshair || !hover || !tooltip) return;
  if (!point || !metrics) {
    crosshair.setAttribute("visibility", "hidden");
    hover.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
    return;
  }
  const x = metrics.x(index);
  const y = metrics.y(point.value);
  crosshair.setAttribute("x1", x.toFixed(1));
  crosshair.setAttribute("x2", x.toFixed(1));
  crosshair.setAttribute("y1", metrics.top);
  crosshair.setAttribute("y2", metrics.top + metrics.plotH);
  crosshair.removeAttribute("visibility");
  hover.setAttribute("cx", x.toFixed(1));
  hover.setAttribute("cy", y.toFixed(1));
  hover.removeAttribute("visibility");
  tooltip.hidden = false;
  tooltip.textContent = `${point.date}  ${formatYi(point.value)} 亿  ${point.label}`;
  const wrap = tooltip.parentElement.getBoundingClientRect();
  const svg = tooltip.parentElement.querySelector(".flow-chart").getBoundingClientRect();
  const left = svg.left - wrap.left + (x / metrics.width) * svg.width + 12;
  tooltip.style.left = `${Math.min(left, wrap.width - tooltip.offsetWidth - 8)}px`;
  tooltip.style.top = `${Math.max(8, svg.top - wrap.top + (y / metrics.height) * svg.height - 28)}px`;
}

function flowChartMetrics(points, width, height) {
  const values = points.map((point) => point.value);
  const frame = { width, height, left: 36, right: 8, top: 8, bottom: 16 };
  const plotW = Math.max(1, frame.width - frame.left - frame.right);
  const plotH = Math.max(1, frame.height - frame.top - frame.bottom);
  const pad = Math.max((Math.max(...values, 0) - Math.min(...values, 0)) * 0.12, 0.5);
  const min = Math.min(...values, 0) - pad;
  const max = Math.max(...values, 0) + pad;
  return {
    ...frame,
    plotW,
    plotH,
    min,
    max,
    y: (value) => frame.top + (max - value) / (max - min) * plotH,
    x: (index) => frame.left + (points.length <= 1 ? plotW / 2 : index / (points.length - 1) * plotW),
  };
}

function layoutFlowChart() {
  const wrap = document.querySelector("#national-team-panel .fear-chart-wrap");
  const points = chartState.flowWindow;
  if (!wrap || !points?.length) return;
  wrap.innerHTML = flowChart(points, Math.max(1, Math.round(wrap.clientWidth)), Math.max(1, Math.round(wrap.clientHeight)));
  syncChartPanelMetric(wrap.closest(".chart-panel"));
}

function flowChart(points, width, height) {
  const metrics = flowChartMetrics(points, width, height);
  const { left, right, top, plotW, plotH, x, y } = metrics;
  const ticks = flowTicks(metrics.min, metrics.max);
  const gap = plotW / points.length;
  const barW = Math.max(1, Math.min(14, gap * 0.62));
  const zero = y(0);
  const axisDate = (date) => date.slice(2);
  const middle = points[Math.floor((points.length - 1) / 2)];
  const middleLabel = width >= 420 ? `<text class="axis" x="${x(Math.floor((points.length - 1) / 2)).toFixed(1)}" y="${height - 3}" text-anchor="middle">${escapeHtml(axisDate(middle.date))}</text>` : "";
  return `<svg class="flow-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="国家队净买卖，横轴为时间，纵轴为亿元">
      ${ticks.map((tick) => `<line class="gridline" x1="${left}" x2="${left + plotW}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}"></line><text class="axis" x="${left - 6}" y="${y(tick).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${formatYi(tick, Math.abs(tick) >= 100 ? 0 : 1).replace("+", "")}</text>`).join("")}
      <line class="zero" x1="${left}" x2="${left + plotW}" y1="${zero.toFixed(1)}" y2="${zero.toFixed(1)}"></line>
      ${points.map((point, index) => {
        const topY = Math.min(zero, y(point.value));
        const barH = Math.max(1, Math.abs(zero - y(point.value)));
        const tone = point.value > 0 ? "flow-buy" : point.value < 0 ? "flow-sell" : "flow-flat";
        return `<rect class="${tone}" x="${(x(index) - barW / 2).toFixed(1)}" y="${topY.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}"></rect>`;
      }).join("")}
      <line class="fear-crosshair" visibility="hidden" x1="${left}" x2="${left}" y1="${top}" y2="${top + plotH}"></line>
      <circle class="fear-hover" visibility="hidden" r="3"></circle>
      <text class="axis" x="${left}" y="${height - 3}">${escapeHtml(axisDate(points[0].date))}</text>
      ${middleLabel}
      <text class="axis" x="${width - right}" y="${height - 3}" text-anchor="end">${escapeHtml(axisDate(points.at(-1).date))}</text>
      <rect class="fear-hit" x="${left}" y="${top}" width="${plotW}" height="${plotH}"></rect>
    </svg>
    <div class="fear-tooltip" hidden></div>`;
}

function flowTicks(min, max) {
  const span = Math.max(max - min, 1);
  const raw = span / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / pow;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * pow;
  const ticks = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 0.01; value += step) ticks.push(Number(value.toFixed(4)));
  if (min < 0 && max > 0 && !ticks.some((tick) => Math.abs(tick) < step / 50)) ticks.push(0);
  return [...new Set(ticks)].sort((left, right) => left - right);
}

function moveFearGreedCursor(event) {
  const svg = event.target.closest(".fear-chart");
  const points = chartState.fearGreedWindow;
  if (!svg || !points?.length || chartResize) { showFearGreedCursor(null); return; }
  const view = svg.viewBox.baseVal;
  if (!view.width || !view.height) return;
  const metrics = fearChartMetrics(points.length, view.width, view.height);
  const rect = svg.getBoundingClientRect();
  const viewX = (event.clientX - rect.left) / rect.width * metrics.width;
  if (viewX < metrics.left || viewX > metrics.left + metrics.plotW) { showFearGreedCursor(null); return; }
  const index = points.length === 1 ? 0 : Math.round((viewX - metrics.left) / metrics.plotW * (points.length - 1));
  showFearGreedCursor(points[index], index, metrics);
}

function showFearGreedCursor(point, index, metrics) {
  const readout = document.querySelector(".fear-readout");
  const note = document.querySelector(".fear-note");
  const mark = document.querySelector(".fear-gauge-mark");
  const crosshair = document.querySelector(".fear-crosshair");
  const hover = document.querySelector(".fear-hover");
  const tooltip = document.querySelector(".fear-tooltip");
  const latest = chartState.fearGreed?.latest;
  const shown = point || latest;
  if (!readout || !shown) return;
  readout.className = `fear-readout ${shown.band}`;
  readout.querySelector("strong").textContent = shown.value.toFixed(1);
  readout.querySelector("span").textContent = shown.label;
  readout.querySelector("time").textContent = shown.date;
  if (note) note.textContent = shown.note;
  if (mark) mark.style.left = `${Math.min(100, Math.max(0, shown.value))}%`;
  if (!crosshair || !hover || !tooltip) return;
  if (!point || !metrics) {
    crosshair.setAttribute("visibility", "hidden");
    hover.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
    return;
  }
  const x = metrics.x(index);
  const y = metrics.y(point.value);
  crosshair.setAttribute("x1", x.toFixed(1));
  crosshair.setAttribute("x2", x.toFixed(1));
  crosshair.setAttribute("y1", metrics.top);
  crosshair.setAttribute("y2", metrics.top + metrics.plotH);
  crosshair.removeAttribute("visibility");
  hover.setAttribute("cx", x.toFixed(1));
  hover.setAttribute("cy", y.toFixed(1));
  hover.removeAttribute("visibility");
  tooltip.hidden = false;
  tooltip.textContent = `${point.date}  ${point.value.toFixed(1)}  ${point.label}`;
  const wrap = tooltip.parentElement.getBoundingClientRect();
  const svg = tooltip.parentElement.querySelector(".fear-chart").getBoundingClientRect();
  const left = svg.left - wrap.left + (x / metrics.width) * svg.width + 12;
  tooltip.style.left = `${Math.min(left, wrap.width - tooltip.offsetWidth - 8)}px`;
  tooltip.style.top = `${Math.max(8, svg.top - wrap.top + (y / metrics.height) * svg.height - 28)}px`;
}

function fearGreedWindow(points, days) {
  if (!days || points.length === 0) return points;
  const end = Date.parse(`${points.at(-1).date}T00:00:00Z`);
  const start = end - days * 86_400_000;
  const windowed = points.filter((point) => Date.parse(`${point.date}T00:00:00Z`) >= start);
  return windowed.length > 0 ? windowed : points.slice(-1);
}

function fearGreedGauge(value) {
  const zones = [[10, "extreme-fear"], [20, "fear"], [20, "neutral"], [20, "greed"], [30, "extreme-greed"]];
  const position = Math.min(100, Math.max(0, value));
  return `<div class="fear-gauge" aria-hidden="true"><div class="fear-gauge-bar"><div class="fear-gauge-track">${zones.map(([size, name]) => `<span class="${name}" style="flex:${size}"></span>`).join("")}</div><span class="fear-gauge-mark" style="left:${position}%"></span></div><div class="fear-gauge-scale"><span>0</span><span>50</span><span>100</span></div></div>`;
}

function fearChartMetrics(count, width, height) {
  const frame = { width, height, left: 30, right: 8, top: 6, bottom: 16 };
  const plotW = Math.max(1, frame.width - frame.left - frame.right);
  const plotH = Math.max(1, frame.height - frame.top - frame.bottom);
  return {
    ...frame,
    plotW,
    plotH,
    y: (value) => frame.top + (100 - value) / 100 * plotH,
    x: (index) => frame.left + (count <= 1 ? plotW / 2 : index / (count - 1) * plotW),
  };
}

function layoutFearGreedChart() {
  const wrap = document.querySelector("#fear-greed-panel .fear-chart-wrap");
  const points = chartState.fearGreedWindow;
  if (!wrap || !points?.length) return;
  const width = Math.max(1, Math.round(wrap.clientWidth));
  const height = Math.max(1, Math.round(wrap.clientHeight));
  wrap.innerHTML = fearGreedChart(points, width, height);
  syncChartPanelMetric(wrap.closest(".chart-panel"));
}

function fearGreedChart(points, width, height) {
  if (points.length === 0) return "";
  const metrics = fearChartMetrics(points.length, width, height);
  const { left, right, top, plotW, plotH, x, y } = metrics;
  const zones = [[0, 10, "extreme-fear"], [10, 30, "fear"], [30, 50, "neutral"], [50, 70, "greed"], [70, 100, "extreme-greed"]];
  const ticks = [0, 25, 50, 75, 100];
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join("");
  const area = `${line}L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const last = points.at(-1);
  const middle = points[Math.floor((points.length - 1) / 2)];
  const axisDate = (date) => date.slice(2);
  const middleLabel = width >= 420 ? `<text class="axis" x="${x(Math.floor((points.length - 1) / 2)).toFixed(1)}" y="${height - 3}" text-anchor="middle">${escapeHtml(axisDate(middle.date))}</text>` : "";
  return `<svg class="fear-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="恐贪指数，横轴为时间，纵轴为 0 到 100">
      ${zones.map(([from, to, name]) => `<rect class="zone ${name}" x="${left}" y="${y(to).toFixed(1)}" width="${plotW}" height="${(y(from) - y(to)).toFixed(1)}"></rect>`).join("")}
      ${ticks.map((tick) => `<line class="gridline" x1="${left}" x2="${left + plotW}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}"></line><text class="axis" x="${left - 6}" y="${y(tick).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${tick}</text>`).join("")}
      <path class="fear-area" d="${area}"></path>
      <path class="fear-line" d="${line}"></path>
      <line class="fear-crosshair" visibility="hidden" x1="${left}" x2="${left}" y1="${top}" y2="${top + plotH}"></line>
      <circle class="fear-hover" visibility="hidden" r="3"></circle>
      <circle class="fear-dot" cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="2.5"></circle>
      <text class="axis" x="${left}" y="${height - 3}">${escapeHtml(axisDate(points[0].date))}</text>
      ${middleLabel}
      <text class="axis" x="${width - right}" y="${height - 3}" text-anchor="end">${escapeHtml(axisDate(last.date))}</text>
      <rect class="fear-hit" x="${left}" y="${top}" width="${plotW}" height="${plotH}"></rect>
    </svg>
    <div class="fear-tooltip" hidden></div>`;
}

function moveEquityCursor(event) {
  const svg = event.target.closest(".equity-chart");
  const points = chartState.equityWindow;
  if (!svg || !points?.length || chartResize) { showEquityCursor(null); return; }
  const view = svg.viewBox.baseVal;
  if (!view.width || !view.height) return;
  const metrics = equityChartMetrics(points, view.width, view.height);
  const rect = svg.getBoundingClientRect();
  const viewX = (event.clientX - rect.left) / rect.width * metrics.width;
  if (viewX < metrics.left || viewX > metrics.left + metrics.plotW) { showEquityCursor(null); return; }
  const index = points.length === 1 ? 0 : Math.round((viewX - metrics.left) / metrics.plotW * (points.length - 1));
  showEquityCursor(points[index], index, metrics);
}

function showEquityCursor(point, index, metrics) {
  const panel = document.querySelector("#equity-bond-panel");
  const readout = panel?.querySelector(".equity-readout");
  const note = panel?.querySelector(".equity-note");
  const crosshair = panel?.querySelector(".fear-crosshair");
  const hover = panel?.querySelector(".fear-hover");
  const tooltip = panel?.querySelector(".fear-tooltip");
  const latest = chartState.equityBond?.latest;
  const bands = chartState.equityBond?.bands || [];
  const shown = point || latest;
  if (!readout || !shown) return;
  const band = equityBandAt(bands, shown.value);
  const bandId = point ? (band?.id || "outside") : latest.band;
  const label = point ? (band?.label || "区间外") : latest.label;
  readout.className = `fear-readout equity-readout ${bandId}`;
  readout.querySelector("strong").textContent = `${shown.value.toFixed(2)}%`;
  readout.querySelector("span").textContent = label;
  readout.querySelector("em").textContent = point
    ? (point.mean == null ? "" : `滚动均值 ${point.mean.toFixed(2)}%`)
    : (latest.percentile == null ? "" : `近10年分位 ${latest.percentile.toFixed(1)}%`);
  readout.querySelector("time").textContent = shown.date;
  if (note) note.textContent = point ? (band?.note || "当前风险溢价落在平台温度带之外。") : latest.note;
  if (!crosshair || !hover || !tooltip) return;
  if (!point || !metrics) {
    crosshair.setAttribute("visibility", "hidden");
    hover.setAttribute("visibility", "hidden");
    tooltip.hidden = true;
    return;
  }
  const x = metrics.x(index);
  const y = metrics.y(point.value);
  crosshair.setAttribute("x1", x.toFixed(1));
  crosshair.setAttribute("x2", x.toFixed(1));
  crosshair.setAttribute("y1", metrics.top);
  crosshair.setAttribute("y2", metrics.top + metrics.plotH);
  crosshair.removeAttribute("visibility");
  hover.setAttribute("cx", x.toFixed(1));
  hover.setAttribute("cy", y.toFixed(1));
  hover.removeAttribute("visibility");
  tooltip.hidden = false;
  tooltip.textContent = `${point.date}  ${point.value.toFixed(2)}%  ${label}`;
  const wrap = tooltip.parentElement.getBoundingClientRect();
  const svg = tooltip.parentElement.querySelector(".equity-chart").getBoundingClientRect();
  const left = svg.left - wrap.left + (x / metrics.width) * svg.width + 12;
  tooltip.style.left = `${Math.min(left, wrap.width - tooltip.offsetWidth - 8)}px`;
  tooltip.style.top = `${Math.max(8, svg.top - wrap.top + (y / metrics.height) * svg.height - 28)}px`;
}

function equityBandAt(bands, value) {
  return bands.find((band) => value >= band.low && value <= band.high) || null;
}

function equityChartMetrics(points, width, height) {
  const values = points.flatMap((point) => point.mean == null ? [point.value] : [point.value, point.mean]);
  const frame = { width, height, left: 36, right: 8, top: 8, bottom: 16 };
  const plotW = Math.max(1, frame.width - frame.left - frame.right);
  const plotH = Math.max(1, frame.height - frame.top - frame.bottom);
  const span = Math.max(...values) - Math.min(...values);
  const pad = Math.max(span * 0.08, 0.05);
  const min = Math.min(...values) - pad;
  const max = Math.max(...values) + pad;
  return {
    ...frame,
    plotW,
    plotH,
    min,
    max,
    y: (value) => frame.top + (max - value) / (max - min) * plotH,
    x: (index) => frame.left + (points.length <= 1 ? plotW / 2 : index / (points.length - 1) * plotW),
  };
}

function layoutEquityBondChart() {
  const wrap = document.querySelector("#equity-bond-panel .fear-chart-wrap");
  const points = chartState.equityWindow;
  if (!wrap || !points?.length) return;
  wrap.innerHTML = equityChart(points, chartState.equityBond?.bands || [], Math.max(1, Math.round(wrap.clientWidth)), Math.max(1, Math.round(wrap.clientHeight)));
  syncChartPanelMetric(wrap.closest(".chart-panel"));
}

function equityChart(points, bands, width, height) {
  const metrics = equityChartMetrics(points, width, height);
  const { left, right, top, plotW, plotH, min, max, x, y } = metrics;
  const ticks = flowTicks(min, max);
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join("");
  const mean = equityMeanPath(points, x, y);
  const last = points.at(-1);
  const middle = points[Math.floor((points.length - 1) / 2)];
  const axisDate = (date) => date.slice(2);
  const middleLabel = width >= 420 ? `<text class="axis" x="${x(Math.floor((points.length - 1) / 2)).toFixed(1)}" y="${height - 3}" text-anchor="middle">${escapeHtml(axisDate(middle.date))}</text>` : "";
  const zones = bands.map((band) => {
    const topY = Math.min(y(band.high), y(band.low));
    const zoneH = Math.abs(y(band.low) - y(band.high));
    return `<rect class="zone ${band.id}" x="${left}" y="${topY.toFixed(1)}" width="${plotW}" height="${zoneH.toFixed(1)}"></rect>`;
  }).join("");
  return `<svg class="equity-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="股债性价比，横轴为时间，纵轴为风险溢价百分比">
      ${zones}
      ${ticks.map((tick) => `<line class="gridline" x1="${left}" x2="${left + plotW}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}"></line><text class="axis" x="${left - 6}" y="${y(tick).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${tick.toFixed(Math.abs(tick) >= 10 ? 0 : 1)}</text>`).join("")}
      ${mean ? `<path class="equity-mean" d="${mean}"></path>` : ""}
      <path class="equity-line" d="${line}"></path>
      <line class="fear-crosshair" visibility="hidden" x1="${left}" x2="${left}" y1="${top}" y2="${top + plotH}"></line>
      <circle class="fear-hover" visibility="hidden" r="3"></circle>
      <circle class="equity-dot" cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="2.5"></circle>
      <text class="axis" x="${left}" y="${height - 3}">${escapeHtml(axisDate(points[0].date))}</text>
      ${middleLabel}
      <text class="axis" x="${width - right}" y="${height - 3}" text-anchor="end">${escapeHtml(axisDate(last.date))}</text>
      <rect class="fear-hit" x="${left}" y="${top}" width="${plotW}" height="${plotH}"></rect>
    </svg>
    <div class="fear-tooltip" hidden></div>`;
}

function equityMeanPath(points, x, y) {
  let path = "";
  let drawing = false;
  points.forEach((point, index) => {
    if (point.mean == null) { drawing = false; return; }
    path += `${drawing ? "L" : "M"}${x(index).toFixed(1)},${y(point.mean).toFixed(1)}`;
    drawing = true;
  });
  return path;
}

function renderDashboard(data) {
  if (state.selectedTask && !data.tasks.some((task) => task.task === state.selectedTask)) state.selectedTask = null;
  const selectedTask = data.tasks.find((task) => task.task === state.selectedTask) ?? null;
  document.querySelector("#nav-task-count").textContent = String(data.tasks.length);
  document.querySelector("[data-view-target='tasks']").title = `定时任务 · ${data.tasks.length}`;
  document.querySelector("#recent-runs-label").textContent = selectedTask ? `最近运行 · ${selectedTask.title}` : "最近运行";
  document.querySelector("#view-all-runs").hidden = !selectedTask;
  elements.traceLink.href = data.agent.phoenixUrl;
  elements.tasks.innerHTML = data.tasks.map((task) => {
    const run = task.running || task.latest;
    const status = run?.status || "idle";
    const selected = task.task === state.selectedTask;
    return `
      <article class="task-card ${escapeHtml(status)} ${selected ? "selected" : ""}" data-select-task="${escapeHtml(task.task)}">
        <div class="task-title-row">
          <button class="task-title-button" type="button">${escapeHtml(task.title)}</button>
          <span class="task-status ${escapeHtml(status)}">${statusLabel(status)}</span>
        </div>
        <p class="task-schedule">${escapeHtml(task.schedule)}</p>
        <div class="task-facts">
          <span>${run ? task.custom ? `${run.sourceCount} 次工具调用` : task.task === "portfolio-risk-check" ? `${run.sourceCount} 持仓` : `${run.sourceCount} 来源` : "尚无运行"}</span>
          <span>${run?.durationMs != null ? formatDuration(run.durationMs) : "—"}</span>
          <span>${run ? task.task === "portfolio-risk-check" ? `${run.warningCount} 风险` : `${run.inputTokens + run.outputTokens} tok` : "—"}</span>
        </div>
        <div class="task-actions">
          <button class="run-now" data-run-task="${escapeHtml(task.task)}">立即运行</button>
          <button class="edit-task" data-edit-task="${escapeHtml(task.task)}" type="button">Prompt 与定时 ↗</button>
        </div>
      </article>`;
  }).join("");

  elements.tasks.querySelectorAll("[data-select-task]").forEach((card) => {
    card.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (button && !button.classList.contains("task-title-button")) return;
      state.selectedTask = card.dataset.selectTask;
      renderDashboard(data);
    });
  });
  elements.tasks.querySelectorAll("[data-run-task]").forEach((button) => {
    button.addEventListener("click", () => runTask(button.dataset.runTask, button));
  });
  elements.tasks.querySelectorAll("[data-edit-task]").forEach((button) => button.addEventListener("click", () => openTaskConfig(button.dataset.editTask)));

  const visibleRuns = selectedTask
    ? (selectedTask.runs ?? data.recentRuns.filter((run) => run.task === selectedTask.task))
    : data.recentRuns;
  elements.recentRuns.innerHTML = visibleRuns.length ? visibleRuns.map((run) => `
    <button class="run-row" type="button" data-run-id="${escapeHtml(run.id)}">
      <span class="run-state ${escapeHtml(run.status)}"></span>
      <span class="run-name">
        ${escapeHtml(taskShortName(run.task))} · ${escapeHtml(modeLabel(run.mode))}
        <small>${escapeHtml(run.id.slice(0, 8))} · ${formatDate(run.startedAt)}</small>
      </span>
      <span class="run-duration">${run.durationMs == null ? "…" : formatDuration(run.durationMs)}</span>
    </button>
  `).join("") : `<p class="task-schedule">${selectedTask ? "这条任务还没有运行记录。" : "任务运行后会出现在这里。"}</p>`;

  elements.recentRuns.querySelectorAll("[data-run-id]").forEach((button) => {
    button.addEventListener("click", () => openRun(button.dataset.runId));
  });

  const capabilities = [
    ["Pi 对话", true],
    ["任务记忆", true],
    [`Skills × ${data.agent.skillCount}`, data.agent.skillCount > 0],
    [`MCP × ${data.agent.mcpCount}`, data.agent.mcpCount > 0],
    [`工具 × ${data.agent.toolCount}`, data.agent.toolCount > 0],
    ["本地 Trace", true],
  ];
  elements.capabilities.innerHTML = capabilities
    .map(([label, active]) => `<span class="capability ${active ? "active" : ""}">${escapeHtml(label)}</span>`)
    .join("");
}

function notificationStatus(status) {
  const label = document.querySelector("#notification-permission-status");
  label.textContent = status === "authorized" ? "Mac 通知已开启" : status === "denied" ? "Mac 通知被系统关闭" : "允许 Mac 通知，及时接收风险提醒";
  document.querySelector("#notification-permission").hidden = status === "authorized";
  document.querySelector("#notification-permission").textContent = status === "denied" ? "系统设置" : "开启通知";
}

function channelBadges(deliveries) {
  if (!deliveries.length) return '<span class="delivery-badge">已存本地</span>';
  const groups = new Map();
  for (const item of deliveries) {
    const name = item.channel === "macos" ? "Mac" : item.channel.startsWith("feishu") ? "飞书" : item.channel === "wechat-work" ? "企业微信" : item.channel;
    const old = groups.get(name);
    groups.set(name, { count: (old?.count || 0) + 1, failed: item.status !== "sent" || old?.failed });
  }
  return [...groups].map(([name, value]) => `<span class="delivery-badge ${value.failed ? "failed" : "sent"}">${escapeHtml(name)}${value.count > 1 ? ` ×${value.count}` : ""} · ${value.failed ? "未投递" : "已投递"}</span>`).join("");
}

async function loadNotifications() {
  try {
    const response = await fetch("/api/notifications");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    document.querySelector("#notification-count").textContent = String(data.unreadCount);
    document.querySelector("#notification-count").title = `${data.unreadCount} 条未读消息`;
    document.querySelector("#notification-indicator").hidden = data.unreadCount === 0;
    if (!data.macosEnabled) {
      document.querySelector("#notification-permission-status").textContent = "Mac 通知已在本地配置中停用";
      document.querySelector("#notification-permission").hidden = true;
    }
    elements.notifications.innerHTML = data.messages.length ? data.messages.map((item) => `
      <button class="notification-card ${escapeHtml(item.severity)} ${item.readAt ? "" : "unread"}" data-notification-id="${escapeHtml(item.id)}" type="button">
        <span class="notification-card-meta"><span class="notification-severity">${({ critical: "高优先级", warning: "需要关注", info: "研究更新" })[item.severity] || "消息"}</span><time datetime="${escapeHtml(item.createdAt)}">${relativeTime(item.createdAt)}</time></span>
        <strong>${escapeHtml(item.title.replace(/^Livermore\s*/, ""))}</strong>
        <span class="notification-preview">${escapeHtml(item.preview)}</span>
        <span class="delivery-badges">${channelBadges(item.deliveries)}</span>
      </button>`).join("") : '<div class="inbox-empty"><strong>还没有推送消息</strong><p>任务完成或发现风险后，摘要会保存在这里，并推送到已启用的渠道。</p></div>';
    elements.notifications.querySelectorAll("[data-notification-id]").forEach((button) => button.addEventListener("click", () => openNotification(button.dataset.notificationId)));
  } catch (error) { console.error("消息读取失败", error); }
}

async function openNotification(id) {
  try {
    const response = await fetch(`/api/notifications/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const message = await response.json();
    const acknowledged = await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
    if (!acknowledged.ok) throw new Error("已读状态保存失败");
    await loadNotifications();
    if (message.runId) {
      if (elements.notificationDialog.open) elements.notificationDialog.close();
      await openRun(message.runId);
      return;
    }
    showNotificationMessage(message);
  } catch (error) {
    showNotificationMessage(null, error.message);
  }
}

function showNotificationMessage(message, error) {
  document.querySelector("#notification-title").textContent = message?.title || "消息读取失败";
  document.querySelector("#notification-meta").innerHTML = message
    ? `<span>${escapeHtml(formatDate(message.createdAt))}</span>${channelBadges(message.deliveries)}`
    : "";
  document.querySelector("#notification-body").innerHTML = message
    ? renderReportMarkdown(message.body)
    : `<p>${escapeHtml(`消息读取失败：${error}`)}</p>`;
  if (!elements.notificationDialog.open) elements.notificationDialog.showModal();
}

async function openTaskConfig(task) {
  if (elements.taskConfigDialog.open) return;
  try {
    const response = await fetch(task ? `/api/tasks/${encodeURIComponent(task)}/config` : "/api/tasks/template");
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    state.taskConfig = value;
    state.taskConfigDirty = false;
    document.querySelector("#task-config-title").textContent = task ? value.title : "新增研究任务";
    document.querySelector("#task-name-field").hidden = !value.custom;
    document.querySelector("#task-name").required = Boolean(value.custom);
    document.querySelector("#task-name").value = value.custom ? value.title : "";
    document.querySelector("#delete-custom-task").hidden = !value.custom || !value.task;
    document.querySelector("#save-task-config").textContent = task ? "保存配置" : "创建研究任务";
    document.querySelector("#task-enabled").checked = value.enabled;
    document.querySelector("#task-timezone").value = value.timezone;
    document.querySelector("#task-prompt").value = value.prompt;
    document.querySelector("#task-config-error").textContent = value.schedulerEnabled ? "" : "全局调度已停用。需在 .env 中启用 TASK_SCHEDULER_ENABLED 后重启服务。";
    document.querySelector("#task-prompt-help").textContent = value.custom ? "独立研究 Agent 可调用已安装的只读 Skills 和工具。支持 {{localNow}}、{{timezone}}、{{nowIso}}、{{mode}}；默认不启用定时，可先手动运行验证。" : task === "portfolio-risk-check"
      ? "编辑巡检任务指令。运行时会注入时间、真实持仓和数据口径；工具权限与确定性风险复核仍保持生效。"
      : "运行时变量：{{sources}} 来源（必须保留）、{{localNow}} 本地时间、{{timezone}} 时区、{{nowIso}} UTC 时间、{{mode}} 模式。";
    document.querySelector("#task-times-label").textContent = value.modes.length > 1 ? "运行时间与模式" : "运行时间";
    document.querySelector("#task-weekdays").innerHTML = ["一", "二", "三", "四", "五", "六", "日"].map((day, index) => `<label><input type="checkbox" value="${index + 1}" ${value.weekdays.includes(index + 1) ? "checked" : ""}><span>${day}</span></label>`).join("");
    document.querySelector("#task-times").replaceChildren();
    for (const item of value.times) appendTaskTime(item.time, item.mode);
    elements.taskConfigDialog.showModal();
  } catch (error) { showToast(`任务配置读取失败：${error.message}`); }
}

function openNewTaskConfig() { return openTaskConfig(null); }

async function deleteCustomTask() {
  const config = state.taskConfig;
  if (!config?.custom || !config.task || !confirm(`删除“${config.title}”并停止后续定时运行？已有报告与运行记录会保留，已开始的任务仍可完成。`)) return;
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(config.task)}`, { method: "DELETE" });
    if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
    state.taskConfigDirty = false; elements.taskConfigDialog.close(); state.taskConfig = null;
    showToast("研究任务已删除，历史报告已保留"); await loadDashboard();
  } catch (error) { document.querySelector("#task-config-error").textContent = error.message; }
}

function appendTaskTime(time, mode) {
  const modes = state.taskConfig?.modes || [];
  const showMode = modes.length > 1;
  const resolved = modes.includes(mode) ? mode : (modes[0] || "research");
  const row = document.createElement("div");
  row.className = showMode ? "task-time-row" : "task-time-row time-only";
  const modeControl = showMode
    ? `<select aria-label="运行模式">${modes.map((item) => `<option value="${escapeHtml(item)}" ${item === resolved ? "selected" : ""}>${escapeHtml(modeLabel(item))}</option>`).join("")}</select>`
    : `<input type="hidden" value="${escapeHtml(resolved)}">`;
  row.innerHTML = `<input type="time" aria-label="运行时间" required value="${escapeHtml(time)}">${modeControl}<button type="button" aria-label="删除运行时间">×</button>`;
  row.querySelector("button").addEventListener("click", () => { row.remove(); state.taskConfigDirty = true; });
  document.querySelector("#task-times").append(row);
}

function closeTaskConfig() {
  if (state.taskConfigDirty && !confirm("放弃尚未保存的任务配置？")) return;
  elements.taskConfigDialog.close(); state.taskConfig = null; state.taskConfigDirty = false;
}

async function saveTaskConfig(event) {
  event.preventDefault();
  const config = state.taskConfig;
  if (!config) return;
  const save = document.querySelector("#save-task-config"); save.disabled = true;
  try {
    const payload = { revision: config.revision, enabled: document.querySelector("#task-enabled").checked, timezone: document.querySelector("#task-timezone").value.trim(), prompt: document.querySelector("#task-prompt").value,
      weekdays: [...document.querySelectorAll("#task-weekdays input:checked")].map((input) => Number(input.value)),
      times: [...document.querySelectorAll(".task-time-row")].map((row) => ({ time: row.querySelector("input").value, mode: row.querySelector("select")?.value || row.querySelector("input[type=hidden]")?.value })) };
    payload.title = document.querySelector("#task-name").value.trim();
    const response = await fetch(config.task ? `/api/tasks/${encodeURIComponent(config.task)}/config` : "/api/tasks", { method: config.task ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    state.taskConfigDirty = false; elements.taskConfigDialog.close(); state.taskConfig = null;
    showToast("配置已保存，下次运行使用新 Prompt 与计划"); await loadDashboard();
  } catch (error) { document.querySelector("#task-config-error").textContent = error.message; }
  finally { save.disabled = false; }
}

let historyMenuId = "";

function closeHistoryMenu() {
  historyMenuId = "";
  const menu = document.querySelector("#history-menu");
  if (menu) menu.hidden = true;
  document.querySelectorAll(".history-row.menu-open").forEach((row) => row.classList.remove("menu-open"));
}

function openHistoryMenu(button) {
  closeHistoryMenu();
  historyMenuId = button.dataset.chatMenu || "";
  const menu = document.querySelector("#history-menu");
  const row = button.closest(".history-row");
  row?.classList.add("menu-open");
  const rect = button.getBoundingClientRect();
  menu.hidden = false;
  const menuRect = menu.getBoundingClientRect();
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8))}px`;
}

function renderChatHistory() {
  const query = state.chatQuery.trim().toLowerCase();
  const chats = state.chats.filter((item) => !query || item.title.toLowerCase().includes(query));
  closeHistoryMenu();
  document.querySelector("#chat-history-list").innerHTML = chats.length ? chats.map((item) => {
    const status = item.status === "running" ? "生成中" : item.status === "error" || item.status === "interrupted" ? "未完成" : "";
    return `<div class="history-row ${item.id === state.sessionId ? "selected" : ""}"><button class="history-open" type="button" data-chat-id="${escapeHtml(item.id)}" title="${escapeHtml(`${item.title} · ${relativeTime(item.updatedAt)}${status ? ` · ${status}` : ""}`)}"><span>${escapeHtml(item.title)}</span></button><button class="history-more" type="button" data-chat-menu="${escapeHtml(item.id)}" aria-label="会话操作：${escapeHtml(item.title)}" aria-haspopup="menu"><svg class="icon"><use href="#i-more"/></svg></button></div>`;
  }).join("") : `<p class="history-empty">${query ? "没有匹配的对话" : "对话会自动保存在这里。"}</p>`;
}

async function loadChatHistory(more = false) {
  try {
    const response = await fetch(`/api/chat/sessions?offset=${more ? state.chats.length : 0}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.chats = more ? [...state.chats, ...data.sessions.filter((item) => !state.chats.some((existing) => existing.id === item.id))] : data.sessions;
    document.querySelector("#more-chats").hidden = data.sessions.length < 100;
    renderChatHistory();
  } catch (error) { console.error("历史会话读取失败", error); }
}

async function restoreConversation() {
  await loadChatHistory();
  if (state.sessionId) await openChat(state.sessionId);
}

async function openChat(id) {
  if (state.sending || state.switchingChat) { showToast("请等待当前对话操作完成后再切换"); return; }
  state.switchingChat = true;
  try {
    const response = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`);
    if (!response.ok) {
      if (response.status === 404 && state.sessionId === id) { state.sessionId = ""; localStorage.removeItem("livermore.sessionId"); }
      throw new Error((await response.json()).error || `HTTP ${response.status}`);
    }
    const data = await response.json();
    state.sessionId = data.id; localStorage.setItem("livermore.sessionId", data.id);
    elements.messages.replaceChildren(elements.welcome); elements.welcome.hidden = data.messages.length > 0;
    for (const message of data.messages) appendMessage(message.role, message.text + (message.error ? `\n\n对话没有完成：${message.error}` : ""), { source: message.text });
    if (data.error && !data.messages.some((message) => message.error === data.error)) appendMessage("assistant", `对话没有完成：${data.error}`);
    document.querySelector("#chat-session-title").textContent = data.title;
    await setView("chat"); await loadChatHistory(); scrollMessages();
  } catch (error) { showToast(`历史会话读取失败：${error.message}`); }
  finally { state.switchingChat = false; }
}

async function deleteChat(id) {
  if (state.sending || state.switchingChat) { showToast("请等待当前对话操作完成后再删除"); return; }
  const title = state.chats.find((item) => item.id === id)?.title || "此会话";
  if (!confirm(`删除“${title}”及其全部对话消息？此操作不可恢复。`)) return;
  try {
    const response = await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
    if (state.sessionId === id) newConversation();
    await loadChatHistory(); showToast("会话已删除");
  } catch (error) { showToast(`删除失败：${error.message}`); }
}

async function saveAtrMultiplier() {
  const input = document.querySelector("#atr-stop-multiplier");
  const value = Number(input.value);
  if (!Number.isFinite(value) || value <= 0 || value > 20) {
    showToast("ATR 倍数需要大于 0，且不超过 20");
    return;
  }
  input.disabled = true;
  try {
    const response = await fetch("/api/portfolio/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ atrStopMultiplier: value }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    input.value = String(result.atrStopMultiplier);
    showToast("ATR 倍数已保存，下次巡检按新倍数重算止损");
  } catch (error) {
    showToast(`ATR 倍数保存失败：${error.message}`);
  } finally {
    input.disabled = false;
  }
}

async function openPortfolio() {
  await setView("portfolio");
}

async function loadPortfolio() {
  try {
    const response = await fetch("/api/portfolio");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.positions = data.positions;
    const multiplier = document.querySelector("#atr-stop-multiplier");
    if (document.activeElement !== multiplier) multiplier.value = String(data.atrStopMultiplier ?? 2);
    renderPortfolio(data.positions);
  } catch (error) {
    showToast(`持仓读取失败：${error.message}`);
  }
}

function renderPortfolio(positions) {
  document.querySelector("#nav-position-count").textContent = String(positions.length);
  document.querySelector("[data-view-target='portfolio']").title = `我的持仓 · ${positions.length}`;
  const warningCount = positions.filter((item) => item.severity === "warning").length;
  const criticalCount = positions.filter((item) => item.severity === "critical").length;
  document.querySelector("#portfolio-count").textContent = String(positions.length);
  document.querySelector("#portfolio-warning-count").textContent = String(warningCount);
  document.querySelector("#portfolio-critical-count").textContent = String(criticalCount);
  const lastChecked = positions.map((item) => item.lastCheckedAt).filter(Boolean).sort().at(-1);
  document.querySelector("#portfolio-last-check").textContent = lastChecked
    ? `最近巡检 ${formatDate(lastChecked)}`
    : "尚未执行风险巡检";
  elements.portfolioEmpty.hidden = positions.length > 0;
  elements.portfolioRows.innerHTML = positions.map((position) => `
    <tr>
      <td data-label="标的">
        <strong>${escapeHtml(position.latestName || position.symbol)}</strong>
        <small>${escapeHtml(position.symbol)} · ${formatPurchaseDate(position.purchasedAt)} 买入</small>
      </td>
      <td class="num" data-label="数量">${formatQuantity(position.quantity)}</td>
      <td class="num" data-label="成本">${formatPrice(position.costBasis)}</td>
      <td class="num" data-label="最新价">${position.latestPrice == null ? "—" : formatPrice(position.latestPrice)}</td>
      <td class="num ${changeClass(position.mainNetInflow)}" data-label="主力净流入">${renderMainFlow(position)}</td>
      <td class="num" data-label="ATR止损">${renderAtrStop(position)}</td>
      <td data-label="价格预警">${renderPriceAlerts(position)}</td>
      <td data-label="持仓盈亏" class="num ${changeClass(position.pnlPct)}">${formatChange(position.pnlPct)}</td>
      <td data-label="当日" class="num ${changeClass(position.dayChangePct)}">${formatChange(position.dayChangePct)}</td>
      <td data-label="风险状态">
        <span class="risk-badge ${escapeHtml(position.severity || "unchecked")}">${riskLabel(position.severity)}</span>
        <small class="risk-summary">${escapeHtml(position.riskSummary || "等待首次巡检")}</small>
      </td>
      <td class="position-actions">
        <button type="button" data-edit-position="${escapeHtml(position.id)}">修改</button>
        <button type="button" data-delete-position="${escapeHtml(position.id)}">删除</button>
      </td>
    </tr>
  `).join("");
  elements.portfolioRows.querySelectorAll("[data-edit-position]").forEach((button) => {
    button.addEventListener("click", () => editPosition(button.dataset.editPosition));
  });
  elements.portfolioRows.querySelectorAll("[data-delete-position]").forEach((button) => {
    button.addEventListener("click", () => deletePosition(button.dataset.deletePosition));
  });
}

async function savePosition(event) {
  event.preventDefault();
  const id = document.querySelector("#position-id").value;
  const button = document.querySelector("#save-position");
  button.disabled = true;
  try {
    const purchasedAt = new Date(document.querySelector("#position-purchased-at").value);
    if (Number.isNaN(purchasedAt.getTime())) throw new Error("买入时间无效");
    const payload = {
      symbol: document.querySelector("#position-symbol").value.trim(),
      quantity: Number(document.querySelector("#position-quantity").value),
      purchasedAt: purchasedAt.toISOString(),
      costBasis: Number(document.querySelector("#position-cost").value),
      alertAbove: optionalAlertPrice("#position-alert-above"),
      alertBelow: optionalAlertPrice("#position-alert-below"),
    };
    if (payload.alertAbove != null && payload.alertBelow != null && payload.alertAbove <= payload.alertBelow) {
      throw new Error("上涨预警价必须高于下跌预警价");
    }
    const response = await fetch(id ? `/api/portfolio/${encodeURIComponent(id)}` : "/api/portfolio", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    showToast(id ? "持仓已更新" : "持仓已添加");
    resetPositionForm();
    await loadPortfolio();
  } catch (error) {
    showToast(`保存失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function editPosition(id) {
  const position = state.positions.find((item) => item.id === id);
  if (!position) return;
  document.querySelector("#position-id").value = position.id;
  document.querySelector("#position-symbol").value = position.symbol;
  document.querySelector("#position-quantity").value = String(position.quantity);
  document.querySelector("#position-purchased-at").value = toDateTimeLocal(new Date(position.purchasedAt));
  document.querySelector("#position-cost").value = String(position.costBasis);
  document.querySelector("#position-alert-above").value = position.alertAbove ?? "";
  document.querySelector("#position-alert-below").value = position.alertBelow ?? "";
  document.querySelector("#save-position").textContent = "保存修改";
  document.querySelector("#cancel-position-edit").hidden = false;
  document.querySelector("#position-symbol").focus();
}

function resetPositionForm() {
  elements.positionForm.reset();
  document.querySelector("#position-id").value = "";
  document.querySelector("#position-purchased-at").value = toDateTimeLocal(new Date());
  document.querySelector("#save-position").textContent = "添加持仓";
  document.querySelector("#cancel-position-edit").hidden = true;
}

async function deletePosition(id) {
  const position = state.positions.find((item) => item.id === id);
  if (!position || !window.confirm(`删除持仓 ${position.latestName || position.symbol}？历史巡检快照也会一并删除。`)) return;
  try {
    const response = await fetch(`/api/portfolio/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    showToast("持仓已删除");
    await loadPortfolio();
  } catch (error) {
    showToast(`删除失败：${error.message}`);
  }
}

async function runPortfolioCheck() {
  const button = document.querySelector("#run-portfolio-check");
  button.disabled = true;
  button.textContent = "巡检已启动";
  try {
    const response = await fetch("/api/tasks/portfolio-risk-check/run", { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    showToast("持仓风险巡检已开始");
    setTimeout(async () => {
      await Promise.all([loadPortfolio(), loadDashboard()]);
      button.disabled = false;
      button.textContent = "立即巡检";
    }, 3500);
  } catch (error) {
    showToast(`巡检启动失败：${error.message}`);
    button.disabled = false;
    button.textContent = "立即巡检";
  }
}

async function openCapabilities(refresh = false) {
  if (state.view !== "capabilities") await setView("capabilities", { refresh });
  else await loadCapabilities(refresh);
}

async function loadCapabilities(refresh = false) {
  elements.skillLedger.innerHTML = loadingLedger();
  elements.mcpLedger.innerHTML = loadingLedger();
  elements.connectionLedger.innerHTML = loadingLedger();
  elements.toolLedger.innerHTML = loadingLedger();
  try {
    const response = await fetch(`/api/capabilities${refresh ? "?refresh=true" : ""}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderCapabilities(data);
  } catch (error) {
    const failure = `<div class="ledger-empty">能力清单读取失败：${escapeHtml(error.message)}</div>`;
    elements.skillLedger.innerHTML = failure;
    elements.mcpLedger.innerHTML = failure;
    elements.connectionLedger.innerHTML = failure;
    elements.toolLedger.innerHTML = failure;
  }
}

function renderCapabilities(data) {
  document.querySelector("#skill-total").textContent = String(data.skills.length);
  document.querySelector("#mcp-total").textContent = String(data.mcps.length);
  document.querySelector("#connection-total").textContent = String(data.connections.length);
  document.querySelector("#tool-total").textContent = String(data.tools.length);

  elements.skillLedger.innerHTML = data.skills.length
    ? data.skills.map((skill) => ledgerItem(skill, [
      ["位置", skill.location],
    ])).join("")
    : `<div class="ledger-empty">
        <strong>尚未安装 Skill</strong>
        <code class="install-command">livermore skill install futuapi</code>
      </div>`;

  elements.mcpLedger.innerHTML = data.mcps.length
    ? data.mcps.map(renderMcp).join("")
    : `<div class="ledger-empty"><strong>还没有 MCP</strong></div>`;
  elements.connectionLedger.innerHTML = data.connections.map((connection) => ledgerItem(connection, [
    ["类型", connection.kind],
    ["地址", connection.endpoint],
  ])).join("");
  elements.toolLedger.innerHTML = data.tools.map((tool) => ledgerItem(tool, [
    ["工具名", tool.name],
  ])).join("");
}

function renderMcp(mcp) {
  const tools = mcp.tools?.length
    ? `<p class="mcp-tool-summary">${escapeHtml(mcp.tools.map((tool) => tool.name).join(" · "))}</p>`
    : "";
  const deleteButton = mcp.system
    ? ""
    : `<button class="secondary-action mcp-delete" type="button" data-mcp-delete="${escapeHtml(mcp.id)}">删除</button>`;
  return `<article class="ledger-item mcp-card" data-mcp-id="${escapeHtml(mcp.id)}" data-mcp-system="${mcp.system ? "true" : "false"}">
    <div class="ledger-item-head">
      <strong>${escapeHtml(mcp.name)}</strong>
      <span class="ledger-status ${escapeHtml(mcp.status)}">${capabilityStatus(mcp.status)}</span>
    </div>
    ${mcp.description ? `<p>${escapeHtml(mcp.description)}</p>` : ""}
    <dl>
      <div><dt>地址</dt><dd>${escapeHtml(mcp.endpoint)}</dd></div>
      <div><dt>密钥</dt><dd>${mcp.hasApiKey ? "已保存" : "未填写"}</dd></div>
    </dl>
    ${mcp.lastError ? `<p class="mcp-error">${escapeHtml(mcp.lastError)}</p>` : ""}
    ${tools}
    <div class="mcp-card-actions">
      <label class="mcp-switch"><input type="checkbox" data-mcp-toggle="${escapeHtml(mcp.id)}" ${mcp.enabled ? "checked" : ""}><span>${mcp.enabled ? "开启" : "关闭"}</span></label>
      <button class="secondary-action" type="button" data-mcp-refresh="${escapeHtml(mcp.id)}">检测</button>
      <button class="secondary-action" type="button" data-mcp-edit="${escapeHtml(mcp.id)}">配置</button>
      ${deleteButton}
    </div>
  </article>`;
}

function openMcpForm(mcp) {
  elements.mcpForm.hidden = false;
  document.querySelector("#add-mcp").hidden = true;
  const idField = document.querySelector("#mcp-id");
  const modeField = document.querySelector("#mcp-mode");
  const apiField = document.querySelector("#mcp-api-key-field");
  const jsonField = document.querySelector("#mcp-json-field");
  const title = document.querySelector("#mcp-form-title");
  idField.value = mcp?.id || "";
  document.querySelector("#mcp-api-key").value = "";
  if (!mcp) {
    modeField.value = "create-json";
    apiField.hidden = true;
    jsonField.hidden = false;
    title.textContent = "添加 MCP";
    document.querySelector("#mcp-json").value = JSON.stringify({
      name: "Example MCP",
      url: "https://mcp.example.com/mcp/",
      description: "",
      authQueryParam: null,
      apiKey: "",
    }, null, 2);
    elements.mcpForm.querySelector("button[type=submit]").textContent = "添加";
    elements.mcpForm.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  if (mcp.system) {
    modeField.value = "tavily-key";
    apiField.hidden = false;
    jsonField.hidden = true;
    title.textContent = mcp.name;
    document.querySelector("#mcp-api-key").placeholder = mcp.hasApiKey ? "已保存，输入新值可覆盖" : "API Key";
    elements.mcpForm.querySelector("button[type=submit]").textContent = "保存";
    elements.mcpForm.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  modeField.value = "edit-json";
  apiField.hidden = true;
  jsonField.hidden = false;
  title.textContent = mcp.name;
  document.querySelector("#mcp-json").value = JSON.stringify({
    ...mcp.config,
    apiKey: "",
  }, null, 2);
  elements.mcpForm.querySelector("button[type=submit]").textContent = "保存";
  elements.mcpForm.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function closeMcpForm() {
  elements.mcpForm.hidden = true;
  elements.mcpForm.reset();
  document.querySelector("#mcp-api-key-field").hidden = false;
  document.querySelector("#mcp-json-field").hidden = true;
  document.querySelector("#add-mcp").hidden = false;
}

async function saveMcp(event) {
  event.preventDefault();
  const id = document.querySelector("#mcp-id").value;
  const mode = document.querySelector("#mcp-mode").value;
  try {
    let body;
    if (mode === "tavily-key") {
      const apiKey = document.querySelector("#mcp-api-key").value.trim();
      if (!apiKey) throw new Error("请填写 Tavily API Key。");
      body = { apiKey };
    } else {
      body = JSON.parse(document.querySelector("#mcp-json").value);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("JSON 必须是对象。");
    }
    const response = await fetch(id ? `/api/mcp/${encodeURIComponent(id)}` : "/api/mcp", {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    closeMcpForm();
    showToast(id ? "MCP 已更新" : "MCP 已添加");
    await reloadCapabilities();
    if (!id || mode === "tavily-key") {
      const targetId = id || payload.id;
      const refreshed = await fetch(`/api/mcp/${encodeURIComponent(targetId)}/refresh`, { method: "POST" });
      if (!refreshed.ok) {
        const failure = await refreshed.json().catch(() => ({}));
        showToast(failure.error || "已保存，工具检测失败");
      }
      await reloadCapabilities();
    }
    loadDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

async function onMcpChange(event) {
  const toggle = event.target.closest("[data-mcp-toggle]");
  if (!toggle) return;
  try {
    await patchMcp(toggle.dataset.mcpToggle, { enabled: toggle.checked });
    if (toggle.checked) {
      const refreshed = await fetch(`/api/mcp/${encodeURIComponent(toggle.dataset.mcpToggle)}/refresh`, { method: "POST" });
      const payload = await refreshed.json().catch(() => ({}));
      if (!refreshed.ok) showToast(payload.error || "已开启，但工具检测失败");
      else showToast(payload.tools?.length ? `MCP 已开启，检测到 ${payload.tools.length} 个工具` : "MCP 已开启");
    } else {
      showToast("MCP 已关闭");
    }
    await reloadCapabilities();
    loadDashboard();
  } catch (error) {
    showToast(error.message);
    await reloadCapabilities();
  }
}

async function onMcpClick(event) {
  if (event.target.closest("[data-mcp-toggle], .mcp-card-actions label, .mcp-switch")) return;
  const refresh = event.target.closest("[data-mcp-refresh]");
  const edit = event.target.closest("[data-mcp-edit]");
  const remove = event.target.closest("[data-mcp-delete]");
  const card = event.target.closest("[data-mcp-id]");
  const id = card?.dataset.mcpId;
  if (!id) return;
  if (!refresh && !edit && !remove) {
    if (card.dataset.mcpSystem === "true") return;
    await openMcpEditor(id);
    return;
  }
  try {
    if (refresh) {
      const response = await fetch(`/api/mcp/${encodeURIComponent(id)}/refresh`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      showToast(payload.tools?.length ? `已检测到 ${payload.tools.length} 个工具` : "没有检测到工具");
    } else if (remove) {
      const name = card.querySelector("strong")?.childNodes[0]?.textContent?.trim() || "这个 MCP";
      if (!confirm(`删除 MCP「${name}」？`)) return;
      const response = await fetch(`/api/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      showToast("MCP 已删除");
    } else if (edit) {
      await openMcpEditor(id);
      return;
    }
    await reloadCapabilities();
    loadDashboard();
  } catch (error) {
    showToast(error.message);
    await reloadCapabilities();
  }
}

async function openMcpEditor(id) {
  const response = await fetch("/api/capabilities");
  const data = await response.json();
  const mcp = data.mcps.find((item) => item.id === id);
  if (!mcp) throw new Error("MCP 不存在。");
  openMcpForm(mcp);
}

async function patchMcp(id, body) {
  const response = await fetch(`/api/mcp/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function reloadCapabilities() {
  const response = await fetch("/api/capabilities");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  renderCapabilities(await response.json());
}

function ledgerItem(item, metadata) {
  return `<article class="ledger-item">
    <div class="ledger-item-head">
      <strong>${escapeHtml(item.label || item.name)}</strong>
      <span class="ledger-status ${escapeHtml(item.status)}">${capabilityStatus(item.status)}</span>
    </div>
    <p>${escapeHtml(item.description || "")}</p>
    <dl>${metadata.map(([label, value]) => `
      <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "—")}</dd></div>
    `).join("")}</dl>
  </article>`;
}

function loadingLedger() {
  return `<div class="ledger-empty">正在读取本地能力清单…</div>`;
}

function capabilityStatus(status) {
  return ({
    available: "可用",
    loadable: "可读取",
    configured: "已配置",
    "needs-configuration": "待配置",
    disabled: "已关闭",
  })[status] || status;
}

async function sendMessage(rawMessage, options = {}) {
  const message = rawMessage?.trim();
  if (!message || state.sending || state.switchingChat) return;
  const replaceFrom = Number.isInteger(options.replaceFrom) ? options.replaceFrom : undefined;
  cancelMessageEdit();
  if (replaceFrom !== undefined) {
    const target = elements.messages.querySelector(`.message.user[data-user-index="${replaceFrom}"]`);
    if (!target) { showToast("找不到要修改的输入"); return; }
    let node = target;
    while (node) {
      const next = node.nextElementSibling;
      if (node !== elements.welcome) node.remove();
      node = next;
    }
  }
  state.sending = true;
  document.body.dataset.sending = "on";
  elements.send.disabled = true;
  elements.prompt.value = "";
  autoSize();
  elements.welcome.hidden = true;
  appendMessage("user", message, { source: message, userIndex: replaceFrom });
  const assistantBody = appendMessage("assistant", "");
  let accumulated = "";

  try {
    if (!state.sessionId) {
      const created = await fetch("/api/chat/sessions", { method: "POST" });
      const record = await created.json();
      if (!created.ok) throw new Error(record.error || `HTTP ${created.status}`);
      state.sessionId = record.id; localStorage.setItem("livermore.sessionId", record.id);
    }
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId || undefined, message, ...(replaceFrom === undefined ? {} : { replaceFrom }) }),
    });
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const event = parseSse(block);
        if (!event) continue;
        if (event.type === "session") {
          state.sessionId = event.data.sessionId;
          localStorage.setItem("livermore.sessionId", state.sessionId);
          loadChatHistory();
        } else if (event.type === "delta") {
          accumulated += event.data.text;
          assistantBody.innerHTML = renderReportMarkdown(accumulated);
          scrollMessages();
        } else if (event.type === "tool_start") {
          elements.toolActivity.hidden = false;
          elements.toolLabel.textContent = toolLabel(event.data.name);
        } else if (event.type === "tool_end") {
          elements.toolLabel.textContent = event.data.error ? "资料查询失败，正在调整回答" : "资料已读取，正在综合";
        } else if (event.type === "error") {
          throw new Error(event.data.message);
        }
      }
      if (done) break;
    }
    if (!accumulated) assistantBody.textContent = "本次没有生成文本回答。";
  } catch (error) {
    assistantBody.innerHTML = `<p>对话没有完成：${escapeHtml(error.message)}</p>`;
  } finally {
    state.sending = false;
    delete document.body.dataset.sending;
    elements.send.disabled = false;
    elements.toolActivity.hidden = true;
    if (state.sessionId) await openChat(state.sessionId);
    await loadChatHistory();
    elements.prompt.focus();
    loadDashboard();
  }
}

let editingMessage = null;

function cancelMessageEdit() {
  if (!editingMessage) return;
  const article = editingMessage;
  editingMessage = null;
  article.classList.remove("editing");
  const body = article.querySelector(".message-body");
  body.innerHTML = renderReportMarkdown(article._sourceText || "");
  const edit = article.querySelector(".message-edit");
  if (edit) edit.hidden = false;
}

function startEditMessage(article) {
  if (state.sending || state.switchingChat) { showToast("请等待当前对话操作完成后再修改"); return; }
  if (editingMessage === article) return;
  cancelMessageEdit();
  editingMessage = article;
  article.classList.add("editing");
  const body = article.querySelector(".message-body");
  body.innerHTML = "";
  const textarea = document.createElement("textarea");
  textarea.className = "message-editor";
  textarea.value = article._sourceText || "";
  textarea.maxLength = 20000;
  textarea.setAttribute("aria-label", "修改输入");
  const actions = document.createElement("div");
  actions.className = "message-editor-actions";
  actions.innerHTML = `<button class="message-edit-cancel" type="button">取消</button><button class="message-edit-submit" type="button">重新发起</button>`;
  body.append(textarea, actions);
  const edit = article.querySelector(".message-edit");
  if (edit) edit.hidden = true;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function appendMessage(role, text, options = {}) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const label = document.createElement("div");
  label.className = "message-role";
  label.textContent = role === "user" ? "You" : "Livermore";
  const body = document.createElement("div");
  body.className = "message-body";
  body.innerHTML = renderReportMarkdown(text);
  article.append(label, body);
  if (role === "user") {
    const userIndex = Number.isInteger(options.userIndex) ? options.userIndex : elements.messages.querySelectorAll(".message.user").length;
    article.dataset.userIndex = String(userIndex);
    article._sourceText = options.source ?? text;
    const actions = document.createElement("div");
    actions.className = "message-actions";
    actions.innerHTML = `<button class="message-edit" type="button" aria-label="修改这条输入"><svg class="icon"><use href="#i-compose"/></svg></button>`;
    article.append(actions);
  }
  elements.messages.append(article);
  scrollMessages();
  return body;
}

elements.messages.addEventListener("click", (event) => {
  const article = event.target.closest(".message.user");
  if (!article) return;
  if (event.target.closest(".message-edit")) startEditMessage(article);
  else if (event.target.closest(".message-edit-cancel")) cancelMessageEdit();
  else if (event.target.closest(".message-edit-submit")) sendMessage(article.querySelector(".message-editor")?.value, { replaceFrom: Number(article.dataset.userIndex) });
});
elements.messages.addEventListener("keydown", (event) => {
  if (!event.target.classList?.contains("message-editor")) return;
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelMessageEdit(); }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    const article = event.target.closest(".message.user");
    sendMessage(event.target.value, { replaceFrom: Number(article.dataset.userIndex) });
  }
});

async function runTask(task, button) {
  button.disabled = true;
  button.textContent = "已触发";
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(task)}/run`, { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    showToast(`${taskShortName(task)}已开始运行`);
    setTimeout(loadDashboard, 1000);
  } catch (error) {
    showToast(`任务启动失败：${error.message}`);
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = "立即运行";
    }, 1500);
  }
}

async function openRun(id) {
  elements.dialogTitle.textContent = "正在读取任务…";
  elements.dialogMeta.innerHTML = "";
  elements.dialogEvaluations.innerHTML = "";
  elements.dialogReport.textContent = "";
  elements.dialog.showModal();
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const run = await response.json();
    elements.dialogTitle.textContent = `${taskShortName(run.task)} · ${modeLabel(run.mode)}`;
    const metadata = [
      `状态 ${statusLabel(run.status)}`,
      `运行 ${formatDate(run.startedAt)}`,
      `耗时 ${run.durationMs == null ? "—" : formatDuration(run.durationMs)}`,
      `${run.task.startsWith("custom-") ? "工具调用" : "来源"} ${run.sourceCount}`,
      `Token ${run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens}`,
      `成本 ${formatCost(run.cost, run.costCurrency)}`,
    ];
    elements.dialogMeta.innerHTML = metadata
      .map((item) => `<span>${escapeHtml(item)}</span>`)
      .join("")
      + (run.traceId
        ? `<a href="${escapeHtml(traceUrl(run.traceId))}" target="_blank" rel="noreferrer">Trace ${escapeHtml(run.traceId.slice(0, 12))} ↗</a>`
        : "<span>无 Trace</span>");
    elements.dialogEvaluations.innerHTML = run.evaluations.map((evaluation) => `
      <div class="evaluation">
        <strong>${escapeHtml(evaluation.evaluator)} · ${escapeHtml(evaluation.label)}</strong>
        ${escapeHtml(evaluation.explanation)}
      </div>
    `).join("");
    elements.dialogReport.innerHTML = run.report
      ? renderReportMarkdown(run.report)
      : `<p>${escapeHtml(run.errorMessage || "本次运行没有报告。")}</p>`;
  } catch (error) {
    elements.dialogTitle.textContent = "任务读取失败";
    elements.dialogReport.textContent = error.message;
  }
}

function traceUrl(traceId) {
  const phoenixUrl = state.dashboard?.agent?.phoenixUrl || "http://localhost:6006";
  return `${phoenixUrl.replace(/\/+$/, "")}/redirects/traces/${encodeURIComponent(traceId)}`;
}

function parseSse(block) {
  let type = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  try { return { type, data: JSON.parse(data.join("\n")) }; }
  catch { return null; }
}

function renderReportMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const language = fence[1] || "text";
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      output.push(`<pre data-language="${escapeHtml(language)}"><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (isTableHeader(lines, index)) {
      const headers = tableCells(lines[index]);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      output.push(`<div class="table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${
        rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("")
      }</tbody></table></div>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      output.push(`<ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
        index += 1;
      }
      output.push(`<ol>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      output.push(`<blockquote>${quote.map((part) => `<p>${inlineMarkdown(part)}</p>`).join("")}</blockquote>`);
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      output.push("<hr>");
      index += 1;
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsReportBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }

  return output.join("");
}

function startsReportBlock(lines, index) {
  const line = lines[index];
  return /^(#{1,6})\s+/.test(line)
    || /^```/.test(line)
    || /^\s*[-*+]\s+/.test(line)
    || /^\s*\d+\.\s+/.test(line)
    || /^>\s?/.test(line)
    || /^\s*(---+|\*\*\*+|___+)\s*$/.test(line)
    || isTableHeader(lines, index);
}

function isTableHeader(lines, index) {
  return Boolean(
    lines[index]?.includes("|")
    && lines[index + 1]
    && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]),
  );
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[S(\d+)\]/g, '<span class="source-tag">S$1</span>');
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

function autoSize() {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 160)}px`;
}

function scrollMessages() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function statusLabel(status) {
  return ({ succeeded: "完成", failed: "失败", running: "运行中", skipped: "跳过", idle: "等待" })[status] || status;
}

function taskShortName(task) {
  if (task === "market-briefing") return "市场简报";
  if (task === "portfolio-risk-check") return "持仓巡检";
  if (task === "ai-industry-chain") return "AI 产业链";
  return state.dashboard?.tasks.find((item) => item.task === task)?.title || "自定义研究";
}

function modeLabel(mode) {
  return ({ "pre-market": "早盘", intraday: "盘中", close: "收盘", hourly: "小时巡检", research: "独立研究" })[mode] || mode;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
}

function formatCost(value, currency = "USD") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  }).format(amount);
}

function relativeTime(value) {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
}

function toDateTimeLocal(date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatPurchaseDate(value) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(value));
}

function formatQuantity(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(value);
}

function renderAtrStop(position) {
  return position.atrStopLoss == null ? "—" : formatPrice(position.atrStopLoss);
}

function renderMainFlow(position) {
  if (position.mainNetInflow == null) return "—";
  const value = Number(position.mainNetInflow);
  const absolute = Math.abs(value);
  if (absolute >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (absolute >= 10_000) return `${(value / 10_000).toFixed(2)}万`;
  return value.toFixed(2);
}

function renderPriceAlerts(position) {
  const rows = [];
  if (position.alertAbove != null) {
    const hit = position.latestPrice != null && position.latestPrice >= position.alertAbove;
    rows.push(`<small class="${hit ? "alert-hit" : ""}">上涨至 ${formatPrice(position.alertAbove)}${hit ? " · 已触发" : ""}</small>`);
  }
  if (position.alertBelow != null) {
    const hit = position.latestPrice != null && position.latestPrice <= position.alertBelow;
    rows.push(`<small class="${hit ? "alert-hit" : ""}">下跌至 ${formatPrice(position.alertBelow)}${hit ? " · 已触发" : ""}</small>`);
  }
  return rows.length > 0 ? rows.join("") : `<small>未设置</small>`;
}

function optionalAlertPrice(selector) {
  const raw = document.querySelector(selector).value.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error("预警价必须是大于 0 的数字");
  return value;
}

function formatPrice(value) {
  return new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

function formatChange(value) {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
}

function changeClass(value) {
  if (value == null || Number(value) === 0) return "";
  return Number(value) > 0 ? "positive" : "negative";
}

function riskLabel(value) {
  return ({ normal: "正常", warning: "警告", critical: "严重", unchecked: "待巡检" })[value || "unchecked"];
}

function toolLabel(name) {
  return ({
    list_task_runs: "正在读取任务运行记录",
    get_task_run: "正在读取任务报告",
    query_a_share_main_fund_flow: "正在查询东方财富主力资金",
    query_futu_market: "正在查询 Futu 行情",
    query_futu_news: "正在查询 Futu 资讯",
    list_available_skills: "正在检查已安装 Skills",
    read_skill: "正在加载研究 Skill",
    save_research_report: "正在保存研究报告",
  })[name] || `正在使用 ${name}`;
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3200);
}
