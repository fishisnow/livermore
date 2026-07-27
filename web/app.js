const state = {
  sessionId: localStorage.getItem("livermore.sessionId") || "",
  sending: false,
  dashboard: null,
  positions: [],
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
};

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

document.querySelector("#new-session").addEventListener("click", () => {
  state.sessionId = "";
  localStorage.removeItem("livermore.sessionId");
  elements.messages.replaceChildren(elements.welcome);
  elements.welcome.hidden = false;
  showToast("已开始新对话");
});

document.querySelector("#refresh").addEventListener("click", loadDashboard);
document.querySelector("#view-all-runs").addEventListener("click", () => {
  elements.recentRuns.scrollIntoView({ behavior: "smooth", block: "start" });
  showToast("这里显示最近 12 次运行，可点击查看报告");
});
document.querySelector("#close-dialog").addEventListener("click", () => elements.dialog.close());
document.querySelector("#portfolio-open").addEventListener("click", openPortfolio);
document.querySelector("#close-portfolio-dialog").addEventListener("click", () => elements.portfolioDialog.close());
document.querySelector("#position-form").addEventListener("submit", savePosition);
document.querySelector("#cancel-position-edit").addEventListener("click", resetPositionForm);
document.querySelector("#run-portfolio-check").addEventListener("click", runPortfolioCheck);
document.querySelector("#capability-details").addEventListener("click", () => openCapabilities(true));
document.querySelector("#close-capability-dialog").addEventListener("click", () => elements.capabilityDialog.close());
document.querySelector("#refresh-capabilities").addEventListener("click", () => openCapabilities(true));

loadDashboard();
setInterval(loadDashboard, 12_000);

async function loadDashboard() {
  try {
    const response = await fetch("/api/dashboard");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.dashboard = await response.json();
    renderDashboard(state.dashboard);
    elements.systemStatus.textContent = `${state.dashboard.agent.provider} / ${state.dashboard.agent.model}`;
  } catch (error) {
    elements.systemStatus.textContent = "本地服务连接异常";
    console.error(error);
  }
}

function renderDashboard(data) {
  elements.traceLink.href = data.agent.phoenixUrl;
  elements.tasks.innerHTML = data.tasks.map((task) => {
    const run = task.running || task.latest;
    const status = run?.status || "idle";
    return `
      <article class="task-card ${escapeHtml(status)}">
        <div class="task-title-row">
          <strong>${escapeHtml(task.title)}</strong>
          <span class="task-status ${escapeHtml(status)}">${statusLabel(status)}</span>
        </div>
        <p class="task-schedule">${escapeHtml(task.schedule)}</p>
        <div class="task-facts">
          <span>${run ? task.task === "portfolio-risk-check" ? `${run.sourceCount} 持仓` : `${run.sourceCount} 来源` : "尚无运行"}</span>
          <span>${run?.durationMs != null ? formatDuration(run.durationMs) : "—"}</span>
          <span>${run ? task.task === "portfolio-risk-check" ? `${run.warningCount} 风险` : `${run.inputTokens + run.outputTokens} tok` : "—"}</span>
        </div>
        <div class="task-actions">
          <button class="run-now" data-run-task="${escapeHtml(task.task)}">立即运行</button>
          <span class="last-time">${run ? relativeTime(run.startedAt) : "等待首次运行"}</span>
        </div>
      </article>`;
  }).join("");

  elements.tasks.querySelectorAll("[data-run-task]").forEach((button) => {
    button.addEventListener("click", () => runTask(button.dataset.runTask, button));
  });

  elements.recentRuns.innerHTML = data.recentRuns.length ? data.recentRuns.map((run) => `
    <button class="run-row" type="button" data-run-id="${escapeHtml(run.id)}">
      <span class="run-state ${escapeHtml(run.status)}"></span>
      <span class="run-name">
        ${escapeHtml(taskShortName(run.task))} · ${escapeHtml(modeLabel(run.mode))}
        <small>${escapeHtml(run.id.slice(0, 8))} · ${formatDate(run.startedAt)}</small>
      </span>
      <span class="run-duration">${run.durationMs == null ? "…" : formatDuration(run.durationMs)}</span>
    </button>
  `).join("") : `<p class="task-schedule">任务运行后会出现在这里。</p>`;

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

async function openPortfolio() {
  if (!elements.portfolioDialog.open) elements.portfolioDialog.showModal();
  if (!document.querySelector("#position-purchased-at").value) {
    document.querySelector("#position-purchased-at").value = toDateTimeLocal(new Date());
  }
  await loadPortfolio();
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
  if (!elements.capabilityDialog.open) elements.capabilityDialog.showModal();
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
        <code class="install-command">livermore skill install hithink-market-query</code>
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
  if (!message || state.sending) return;
  state.sending = true;
  elements.send.disabled = true;
  elements.prompt.value = "";
  autoSize();
  elements.welcome.hidden = true;
  appendMessage("user", message);
  const assistantBody = appendMessage("assistant", "");
  let accumulated = "";

  try {
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
    elements.dialogMeta.innerHTML = [
      `状态 ${statusLabel(run.status)}`,
      `运行 ${formatDate(run.startedAt)}`,
      `耗时 ${run.durationMs == null ? "—" : formatDuration(run.durationMs)}`,
      `来源 ${run.sourceCount}`,
      `Token ${run.inputTokens + run.outputTokens}`,
      `成本 $${Number(run.cost).toFixed(6)}`,
      run.traceId ? `Trace ${run.traceId.slice(0, 12)}` : "无 Trace",
    ].map((item) => `<span>${escapeHtml(item)}</span>`).join("");
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
  return "AI 产业链";
}

function modeLabel(mode) {
  return ({ "pre-market": "早盘", intraday: "盘中", close: "收盘", hourly: "小时巡检" })[mode] || mode;
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
    query_iwencai_market: "正在查询同花顺问财行情",
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
