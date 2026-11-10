const state = {
  sessionId: localStorage.getItem("livermore.sessionId") || "",
  sending: false,
  dashboard: null,
  positions: [],
  view: "chat",
  taskConfig: null,
  taskConfigDirty: false,
  notificationRunId: null,
  selectedTask: null,
  chats: [],
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
  connectionLedger: document.querySelector("#connection-ledger"),
  toolLedger: document.querySelector("#tool-ledger"),
  toast: document.querySelector("#toast"),
  traceLink: document.querySelector("#trace-link"),
  traceLookup: document.querySelector("#trace-lookup"),
  traceId: document.querySelector("#trace-id"),
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
document.body.dataset.sidebar = localStorage.getItem("livermore.sidebar") || "expanded";
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
  document.body.dataset.sidebar = document.body.dataset.sidebar === "collapsed" ? "expanded" : "collapsed";
  localStorage.setItem("livermore.sidebar", document.body.dataset.sidebar);
}
compactWindow.addEventListener("change", syncInspector);
syncInspector();
document.querySelector("#toggle-sidebar").addEventListener("click", toggleSidebar);
document.querySelector("#toggle-inspector").addEventListener("click", toggleInspector);
document.querySelector(".conversation").addEventListener("pointerdown", () => {
  if (compactWindow.matches && document.body.dataset.inspector === "open") toggleInspector();
});
document.querySelector("#native-settings").addEventListener("click", () => nativeBridge?.postMessage({ type: "settings" }));
const views = {
  chat: ["研究对话", "与你的本地投资 Agent 一起研究"],
  portfolio: ["我的持仓", "持仓维护 · 风险监测 · 操作建议"],
  tasks: ["定时任务", "选择任务后，只显示该任务的运行记录"],
  capabilities: ["研究能力", "已安装的 Skills、MCP 与数据连接"],
};
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
}
document.querySelectorAll("[data-view-target]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.viewTarget)));
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
document.querySelector("#refresh-chats").addEventListener("click", () => loadChatHistory());
document.querySelector("#more-chats").addEventListener("click", () => loadChatHistory(true));
document.querySelector("#notification-permission").addEventListener("click", () => nativeBridge?.postMessage({ type: "notification-permission" }));
document.querySelector("#close-notification").addEventListener("click", () => elements.notificationDialog.close());
document.querySelector("#notification-run").addEventListener("click", () => { elements.notificationDialog.close(); if (state.notificationRunId) openRun(state.notificationRunId); });
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
document.querySelector("#capability-details").addEventListener("click", () => openCapabilities(true));
document.querySelector("#close-capability-dialog").addEventListener("click", () => setView("chat"));
document.querySelector("#refresh-capabilities").addEventListener("click", () => openCapabilities(true));
elements.traceLookup.addEventListener("submit", openTraceById);

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

function renderDashboard(data) {
  if (state.selectedTask && !data.tasks.some((task) => task.task === state.selectedTask)) state.selectedTask = null;
  const selectedTask = data.tasks.find((task) => task.task === state.selectedTask) ?? null;
  document.querySelector("#nav-task-count").textContent = String(data.tasks.length);
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
  document.querySelector("#notification-title").textContent = "正在读取消息…";
  document.querySelector("#notification-meta").replaceChildren();
  document.querySelector("#notification-body").replaceChildren();
  document.querySelector("#notification-run").hidden = true;
  state.notificationRunId = null;
  if (!elements.notificationDialog.open) elements.notificationDialog.showModal();
  try {
    const response = await fetch(`/api/notifications/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const message = await response.json();
    document.querySelector("#notification-title").textContent = message.title;
    document.querySelector("#notification-meta").innerHTML = `<span>${escapeHtml(formatDate(message.createdAt))}</span>${channelBadges(message.deliveries)}`;
    document.querySelector("#notification-body").innerHTML = renderReportMarkdown(message.body);
    state.notificationRunId = message.runId;
    document.querySelector("#notification-run").hidden = !message.runId;
    const acknowledged = await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
    if (!acknowledged.ok) throw new Error("已读状态保存失败");
    await loadNotifications();
  } catch (error) { document.querySelector("#notification-body").textContent = `消息读取失败：${error.message}`; }
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
  const row = document.createElement("div"); row.className = "task-time-row";
  row.innerHTML = `<input type="time" aria-label="运行时间" required value="${escapeHtml(time)}"><select aria-label="运行模式">${(state.taskConfig?.modes || []).map((item) => `<option value="${escapeHtml(item)}" ${item === mode ? "selected" : ""}>${escapeHtml(modeLabel(item))}</option>`).join("")}</select><button type="button" aria-label="删除运行时间">×</button>`;
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
      times: [...document.querySelectorAll(".task-time-row")].map((row) => ({ time: row.querySelector("input").value, mode: row.querySelector("select").value })) };
    payload.title = document.querySelector("#task-name").value.trim();
    const response = await fetch(config.task ? `/api/tasks/${encodeURIComponent(config.task)}/config` : "/api/tasks", { method: config.task ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    state.taskConfigDirty = false; elements.taskConfigDialog.close(); state.taskConfig = null;
    showToast("配置已保存，下次运行使用新 Prompt 与计划"); await loadDashboard();
  } catch (error) { document.querySelector("#task-config-error").textContent = error.message; }
  finally { save.disabled = false; }
}

async function loadChatHistory(more = false) {
  try {
    const response = await fetch(`/api/chat/sessions?offset=${more ? state.chats.length : 0}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.chats = more ? [...state.chats, ...data.sessions.filter((item) => !state.chats.some((existing) => existing.id === item.id))] : data.sessions;
    document.querySelector("#more-chats").hidden = data.sessions.length < 100;
    document.querySelector("#chat-history-list").innerHTML = state.chats.length ? state.chats.map((item) => `<div class="history-row ${item.id === state.sessionId ? "selected" : ""}"><button class="history-open" type="button" data-chat-id="${escapeHtml(item.id)}" title="${escapeHtml(item.title)}"><span>${escapeHtml(item.title)}</span><small>${relativeTime(item.updatedAt)}${item.status === "running" ? " · 生成中" : item.status === "error" || item.status === "interrupted" ? " · 未完成" : ""}</small></button><button class="history-delete" data-delete-chat="${escapeHtml(item.id)}" aria-label="删除会话：${escapeHtml(item.title)}" type="button">×</button></div>`).join("") : '<p class="history-empty">开始对话后，会自动保存在这里。</p>';
    document.querySelectorAll("[data-chat-id]").forEach((button) => button.addEventListener("click", () => openChat(button.dataset.chatId)));
    document.querySelectorAll("[data-delete-chat]").forEach((button) => button.addEventListener("click", () => deleteChat(button.dataset.deleteChat)));
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
    for (const message of data.messages) appendMessage(message.role, message.text + (message.error ? `\n\n对话没有完成：${message.error}` : ""));
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

async function openPortfolio() {
  await setView("portfolio");
}

async function loadPortfolio() {
  try {
    const response = await fetch("/api/portfolio");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.positions = data.positions;
    renderPortfolio(data.positions);
  } catch (error) {
    showToast(`持仓读取失败：${error.message}`);
  }
}

function renderPortfolio(positions) {
  document.querySelector("#nav-position-count").textContent = String(positions.length);
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
      <td data-label="数量">${formatQuantity(position.quantity)}</td>
      <td data-label="成本">${formatPrice(position.costBasis)}</td>
      <td data-label="最新价">${position.latestPrice == null ? "—" : formatPrice(position.latestPrice)}</td>
      <td data-label="持仓盈亏" class="${changeClass(position.pnlPct)}">${formatChange(position.pnlPct)}</td>
      <td data-label="当日" class="${changeClass(position.dayChangePct)}">${formatChange(position.dayChangePct)}</td>
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
    };
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
      ["加载", skill.loading === "on-demand" ? "按需读取" : skill.loading],
    ])).join("")
    : `<div class="ledger-empty">
        <strong>尚未安装 Livermore 专属 Skill</strong>
        <p>技能应安装到项目的 <code>skills/</code> 目录。全局 Codex Skills 不会出现在这里。</p>
        <code class="install-command">livermore skill install futuapi</code>
      </div>`;

  elements.mcpLedger.innerHTML = data.mcps.map((mcp) => ledgerItem(mcp, [
    ["传输", mcp.transport],
    ["地址", mcp.endpoint],
  ])).join("");
  elements.connectionLedger.innerHTML = data.connections.map((connection) => ledgerItem(connection, [
    ["类型", connection.kind],
    ["地址", connection.endpoint],
  ])).join("");
  elements.toolLedger.innerHTML = data.tools.map((tool) => ledgerItem(tool, [
    ["工具名", tool.name],
  ])).join("");
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

async function sendMessage(rawMessage) {
  const message = rawMessage?.trim();
  if (!message || state.sending || state.switchingChat) return;
  state.sending = true;
  elements.send.disabled = true;
  elements.prompt.value = "";
  autoSize();
  elements.welcome.hidden = true;
  appendMessage("user", message);
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
      body: JSON.stringify({ sessionId: state.sessionId || undefined, message }),
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
          assistantBody.innerHTML = renderMarkdown(accumulated);
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
    elements.send.disabled = false;
    elements.toolActivity.hidden = true;
    if (state.sessionId) await openChat(state.sessionId);
    await loadChatHistory();
    elements.prompt.focus();
    loadDashboard();
  }
}

function appendMessage(role, text) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const label = document.createElement("div");
  label.className = "message-role";
  label.textContent = role === "user" ? "You" : "Livermore";
  const body = document.createElement("div");
  body.className = "message-body";
  body.innerHTML = renderMarkdown(text);
  article.append(label, body);
  elements.messages.append(article);
  scrollMessages();
  return body;
}

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

function openTraceById(event) {
  event.preventDefault();
  const traceId = elements.traceId.value.trim().replace(/^0x/i, "");
  if (!/^[a-f0-9]{32}$/i.test(traceId)) {
    showToast("Trace ID 应为 32 位十六进制字符");
    elements.traceId.focus();
    return;
  }
  const opened = window.open(traceUrl(traceId), "_blank", "noopener,noreferrer");
  if (!opened) window.location.assign(traceUrl(traceId));
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

function renderMarkdown(value) {
  if (!value) return "";
  const lines = String(value).split("\n");
  let html = "";
  let listOpen = false;
  for (const line of lines) {
    if (/^[-*] /.test(line)) {
      if (!listOpen) { html += "<ul>"; listOpen = true; }
      html += `<li>${inlineMarkdown(line.slice(2))}</li>`;
      continue;
    }
    if (listOpen) { html += "</ul>"; listOpen = false; }
    if (line.startsWith("### ")) html += `<h3>${inlineMarkdown(line.slice(4))}</h3>`;
    else if (line.startsWith("## ")) html += `<h2>${inlineMarkdown(line.slice(3))}</h2>`;
    else if (line.startsWith("# ")) html += `<h2>${inlineMarkdown(line.slice(2))}</h2>`;
    else if (line.trim()) html += `<p>${inlineMarkdown(line)}</p>`;
  }
  if (listOpen) html += "</ul>";
  return html;
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
    search_investment_web: "正在通过 Tavily MCP 搜索",
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
