let toast = () => {};
let data = null;
let detail = null;
let screen = { kind: "list", id: "" };
let pending = "";
let requestId = 0;
let editingTheme = false;
let detailTab = "snapshot";
let historyVisible = { runs: 5, signals: 5 };
let menuOpen = false;
/** @type {{ logs: string[], thinking: string, tool: string | null } | null} */
let checkLive = null;

export function bindRadar(notify) {
  toast = notify;
  const root = document.querySelector("#radar-root");
  if (!root) return;
  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  document.addEventListener("click", () => {
    if (!menuOpen) return;
    menuOpen = false;
    if (screen.kind === "detail") paint();
  });
}

export function openRadar() {
  return load();
}

export function prefetchRadar() {
  if (document.activeElement?.id === "radar-text") return Promise.resolve();
  return load();
}

async function load() {
  const token = ++requestId;
  try {
    const next = await api("/api/watches");
    if (token !== requestId) return;
    data = next;
    if (screen.kind === "detail") {
      detail = await api(`/api/watches/${encodeURIComponent(screen.id)}`);
      if (token !== requestId) return;
    }
    paint();
  } catch (error) {
    if (token !== requestId) return;
    const message = error instanceof Error ? error.message : "雷达没有加载出来";
    toast(message);
    const root = document.querySelector("#radar-root");
    if (root && !data) root.innerHTML = `<p class="radar-lead">${esc(message)}</p>`;
  }
}

function paint() {
  const root = document.querySelector("#radar-root");
  if (!root) return;
  if (data) updateNav(data);
  root.classList.toggle("radar-is-detail", screen.kind === "detail");
  root.innerHTML = screen.kind === "detail" ? detailHtml() : listHtml();
}

function updateNav(list) {
  const active = list.tracking.filter((item) => item.status === "active").length;
  const changed = list.tracking.some((item) => item.attention === "近期有新变化" || item.attention === "检查失败");
  const slot = document.querySelector("#nav-watch-count");
  const button = document.querySelector("[data-view-target='radar']");
  if (slot) slot.textContent = active ? String(active) : "";
  if (button) {
    button.title = active ? `雷达 · ${active} 个正在跟踪` : "雷达";
    button.dataset.radarAlert = changed ? "true" : "false";
  }
}

function listHtml() {
  if (!data) return `<p class="radar-lead">正在读取观察。</p>`;
  const refresh = data.modelAvailable ? "让 AI 重写候选" : "按持仓重新生成";
  const tracking = data.tracking.length
    ? data.tracking.map(watchRow).join("")
    : `<p class="radar-empty">还没有正在监测的问题。从下面选一个，或写下你想跟踪的事。</p>`;
  const candidates = data.candidates.length
    ? data.candidates.map(candidateCard).join("")
    : `<p class="radar-empty">没有待确认的观察。写下一句话，或按持仓重新生成。</p>`;
  const ended = data.ended.length
    ? `<details class="radar-ended"><summary>已结束 · ${data.ended.length}</summary>${data.ended.map(watchRow).join("")}</details>`
    : "";
  return `
    <p class="radar-lead">AI 提出值得持续验证的问题。你写下的一句话也会由 AI 拆解监测维度（问句保持你的原话）。确认后每天只比较新证据和上次状态。</p>
    <form class="radar-compose" id="radar-idea">
      <label class="sr-only" for="radar-text">想跟踪的问题</label>
      <input id="radar-text" name="text" maxlength="200" placeholder="写下想跟踪的问题，例如：AI 巨头的资本开支增速是否开始放缓" autocomplete="off">
      <button class="primary-button" type="submit" ${pending ? "disabled" : ""}>${pending === "idea" ? "正在生成" : "生成观察"}</button>
    </form>
    <div class="radar-block">
      <div class="radar-block-head"><span>正在监测</span><span>${data.tracking.length}</span></div>
      ${tracking}
    </div>
    <div class="radar-block">
      <div class="radar-block-head"><span>发现的观察主题</span><button type="button" data-refresh ${pending ? "disabled" : ""}>${pending === "refresh" ? "正在整理" : refresh}</button></div>
      <p class="radar-note">${data.modelAvailable ? "可以让 AI 按当前持仓重写候选。确认后才开始跟踪。" : "候选按持仓和你写下的问题生成。确认后才开始跟踪。"}</p>
      ${candidates}
    </div>
    ${ended}
  `;
}

function watchRow(item) {
  const line = marketLine(item.state);
  return `
    <button class="watch-row" type="button" data-open="${esc(item.id)}">
      <strong>${esc(item.question)}</strong>
      ${line ? `<span class="watch-state-line">${esc(line)}</span>` : ""}
      <span class="watch-meta"><em class="${tone(item.attention)}">${esc(item.attention)}</em><span>${esc(item.checkedLabel)}</span>${item.signalCount ? `<span>${item.signalCount} 条变化</span>` : ""}</span>
    </button>
  `;
}

function candidateCard(item) {
  const focus = item.scope.focus.map((word) => `<span>${esc(word)}</span>`).join("");
  return `
    <article class="candidate-card">
      <h3>${esc(item.question)}</h3>
      <p>${esc(item.rationale)}</p>
      <div class="focus-row">${focus}</div>
      <div class="radar-actions">
        <button class="primary-button" type="button" data-track="${esc(item.id)}" ${pending ? "disabled" : ""}>开始跟踪</button>
        <button class="quiet-button" type="button" data-dismiss="${esc(item.id)}" ${pending ? "disabled" : ""}>忽略</button>
      </div>
    </article>
  `;
}

function detailHtml() {
  if (!detail) return `<p class="radar-lead">正在读取这条观察。</p>`;
  const watch = detail.watch;
  const failed = watch.latestRun?.status === "failed" ? watch.latestRun : null;
  const checking = isWatchChecking(watch);
  const checkButton = watch.status === "active"
    ? `<button class="primary-button${checking ? " is-loading" : ""}" type="button" data-check ${checking ? "disabled" : ""} aria-busy="${checking ? "true" : "false"}">${checking ? `<span class="btn-spinner" aria-hidden="true"></span>检查中` : "立即检查"}</button>`
    : watch.status === "paused"
      ? `<button class="primary-button" type="button" data-status="active" ${pending ? "disabled" : ""}>继续跟踪</button>`
      : "";
  return `
    <header class="radar-detail-head">
      <button class="quiet-button radar-back" type="button" data-back>返回</button>
      <div class="radar-toolbar">
        ${checkButton}
        ${detailMenu(watch)}
      </div>
    </header>
    <section class="radar-hero">
      <div class="radar-chips">${statusChips(watch, detail.signals.length)}</div>
      ${themeBlock(watch)}
      ${failed ? `<p class="radar-alert">${esc(failed.error || "这次检查没有完成。")} 这次不能判断市场预期有没有变化。</p>` : ""}
    </section>
    ${checkLiveHtml(watch)}
    ${detailTabs()}
    ${detailTabPanel(watch, detail, failed)}
  `;
}

function isWatchChecking(watch) {
  return pending === "check" || watch?.latestRun?.status === "running";
}

function checkLiveHtml(watch) {
  if (!isWatchChecking(watch) && !checkLive) return "";
  const logs = checkLive?.logs ?? [];
  const thinking = checkLive?.thinking ?? "";
  const steps = logs.length
    ? `<ol class="radar-check-steps">${logs.map((line) => `<li>${esc(line)}</li>`).join("")}</ol>`
    : `<p class="radar-quiet">Agent 正在启动…</p>`;
  const think = thinking
    ? `<pre class="radar-check-thinking">${esc(thinking)}</pre>`
    : "";
  const tool = checkLive?.tool ? `<span class="radar-check-tool">当前：${esc(checkLive.tool)}</span>` : "";
  return `
    <section class="radar-check-live" id="radar-check-live" aria-live="polite">
      <div class="radar-block-head"><span>检查过程</span>${tool}</div>
      <div class="radar-check-live-body" id="radar-check-live-body">
        ${steps}
        ${think}
      </div>
    </section>`;
}

function refreshCheckLiveDom() {
  const root = document.querySelector("#radar-check-live");
  const body = document.querySelector("#radar-check-live-body");
  if (!root || !body || !checkLive) return;
  const steps = checkLive.logs.length
    ? `<ol class="radar-check-steps">${checkLive.logs.map((line) => `<li>${esc(line)}</li>`).join("")}</ol>`
    : `<p class="radar-quiet">Agent 正在启动…</p>`;
  const think = checkLive.thinking
    ? `<pre class="radar-check-thinking">${esc(checkLive.thinking)}</pre>`
    : "";
  const tool = checkLive.tool ? `<span class="radar-check-tool">当前：${esc(checkLive.tool)}</span>` : "";
  const head = root.querySelector(".radar-block-head");
  if (head) head.innerHTML = `<span>检查过程</span>${tool}`;
  body.innerHTML = `${steps}${think}`;
  body.scrollTop = body.scrollHeight;
}

function ingestCheckProgress(event) {
  if (!checkLive) checkLive = { logs: [], thinking: "", tool: null };
  if (event.type === "log" && event.text) {
    const last = checkLive.logs[checkLive.logs.length - 1];
    if (last !== event.text) {
      checkLive.logs.push(event.text);
      if (checkLive.logs.length > 100) checkLive.logs.shift();
    }
  } else if (event.type === "delta" && event.text) {
    checkLive.thinking += event.text;
    if (checkLive.thinking.length > 16_000) checkLive.thinking = checkLive.thinking.slice(-12_000);
  } else if (event.type === "tool_start") {
    checkLive.tool = event.label || event.name;
  } else if (event.type === "tool_end") {
    checkLive.tool = null;
  }
  refreshCheckLiveDom();
}

function detailMenu(watch) {
  if (watch.status === "candidate") return "";
  return `
    <div class="radar-menu">
      <button type="button" class="icon-button radar-menu-trigger" aria-label="更多操作" aria-haspopup="menu" aria-expanded="${menuOpen ? "true" : "false"}" data-menu-toggle ${pending ? "disabled" : ""}>
        <svg class="icon"><use href="#i-more"/></svg>
      </button>
      ${menuOpen ? `
      <div class="radar-menu-panel" role="menu" aria-label="观察操作">
        ${watch.status === "active" ? `<button type="button" role="menuitem" data-status="paused" ${pending ? "disabled" : ""}>暂停跟踪</button>` : ""}
        ${watch.status === "paused" ? `<button type="button" role="menuitem" data-status="active" ${pending ? "disabled" : ""}>继续跟踪</button>` : ""}
        ${watch.status !== "ended" ? `<button type="button" role="menuitem" data-status="ended" ${pending ? "disabled" : ""}>结束跟踪</button>` : ""}
        <button type="button" role="menuitem" class="is-danger" data-delete-watch ${pending ? "disabled" : ""}>删除主题</button>
      </div>` : ""}
    </div>`;
}

function detailTabs() {
  const tabs = [
    { id: "snapshot", label: "概览" },
    { id: "runs", label: "检查记录", count: detail?.runs?.length ?? 0 },
    { id: "signals", label: "Signal", count: detail?.signals?.length ?? 0 },
  ];
  return `
    <div class="radar-tabs" role="tablist" aria-label="观察详情分区">
      ${tabs.map((tab) => `
        <button type="button" class="radar-tab${detailTab === tab.id ? " is-active" : ""}" role="tab" data-tab="${tab.id}" aria-selected="${detailTab === tab.id ? "true" : "false"}">
          ${esc(tab.label)}${tab.count == null ? "" : ` <span class="radar-tab-count">${tab.count}</span>`}
        </button>`).join("")}
    </div>`;
}

function detailTabPanel(watch, detailView, failed) {
  if (detailTab === "runs") return runsPanel(detailView.runs);
  if (detailTab === "signals") return signalsPanel(detailView.signals);
  const latest = detailView.signals[0];
  const disagreements = watch.state.uncertainties.length
    ? watch.state.uncertainties.join("、")
    : "还没有从证据里看到明确分歧。";
  const latestBlock = latest
    ? `<div class="radar-latest-box is-hot"><span>最新变化</span><p>${esc(latest.summary)}</p></div>`
    : `<div class="radar-latest-box"><span>最新变化</span><p>暂无</p></div>`;
  const previewRuns = detailView.runs.slice(0, 2).map(runRow).join("");
  return `
    <section class="radar-tab-body" role="tabpanel">
      <div class="radar-snapshot">
        <p class="radar-snapshot-lead">${esc(shownNarrative(watch.state))}</p>
        ${latestBlock}
        <dl class="radar-meta">
          <div><dt>市场预期</dt><dd>${esc(shownExpectation(watch.state))}</dd></div>
          <div><dt>关键分歧</dt><dd>${esc(disagreements)}</dd></div>
          ${focusMonitorBlock(watch, data?.modelAvailable)}
        </dl>
      </div>
      ${detailView.runs.length ? `
        <div class="radar-preview">
          <div class="radar-block-head"><span>最近检查</span><button type="button" class="quiet-button" data-tab="runs">查看全部</button></div>
          <ul class="run-log">${previewRuns}</ul>
        </div>` : ""}
    </section>`;
}

function runsPanel(runs) {
  if (!runs.length) return `<section class="radar-tab-body"><p class="radar-quiet">还没有检查记录。</p></section>`;
  const visible = runs.slice(0, historyVisible.runs);
  const remaining = runs.length - visible.length;
  return `
    <section class="radar-tab-body" role="tabpanel">
      <p class="radar-note">按时间倒序，最新的在最上。引用材料在每条记录下展开。</p>
      <ul class="run-log">${visible.map(runRow).join("")}</ul>
      ${remaining > 0 ? `<button type="button" class="quiet-button radar-load-more" data-more-runs>再显示 ${Math.min(8, remaining)} 条 · 还剩 ${remaining}</button>` : ""}
    </section>`;
}

function signalsPanel(signals) {
  if (!signals.length) {
    return `<section class="radar-tab-body"><p class="radar-quiet">尚无 Signal。只有足以改变判断的证据会出现在这里。</p></section>`;
  }
  const visible = signals.slice(0, historyVisible.signals);
  const remaining = signals.length - visible.length;
  return `
    <section class="radar-tab-body" role="tabpanel">
      <ol class="signal-timeline">${visible.map(signalCard).join("")}</ol>
      ${remaining > 0 ? `<button type="button" class="quiet-button radar-load-more" data-more-signals>再显示 ${Math.min(5, remaining)} 条 · 还剩 ${remaining}</button>` : ""}
    </section>`;
}

function themeBlock(watch) {
  if (editingTheme) {
    return `
      <form class="radar-theme-form" id="radar-theme">
        <label class="sr-only" for="radar-theme-input">观察主题</label>
        <textarea id="radar-theme-input" name="question" maxlength="120" rows="3" ${pending ? "disabled" : ""}>${esc(watch.question)}</textarea>
        <p class="radar-note">写一个可持续对照的问题。观察维度留在下面的重点监测里。</p>
        <div class="radar-actions">
          <button class="primary-button" type="submit" ${pending === "theme" ? "disabled" : ""}>${pending === "theme" ? "正在保存" : "保存主题"}</button>
          <button class="quiet-button" type="button" data-cancel-theme ${pending ? "disabled" : ""}>取消</button>
        </div>
      </form>`;
  }
  return `
    <div class="radar-question-row">
      <h2 class="radar-question">${esc(watch.question)}</h2>
      <button class="quiet-button radar-edit" type="button" data-edit-theme ${pending ? "disabled" : ""} aria-label="修改主题">修改</button>
    </div>`;
}

function statusChips(watch, signalCount) {
  const chips = [`<span class="radar-chip">${esc(statusChip(watch))}</span>`, `<span class="radar-chip">${esc(watch.checkedLabel)}</span>`];
  if (signalCount > 0) chips.push(`<span class="radar-chip is-alert">${signalCount} 条变化</span>`);
  else if (watch.state.baselined) chips.push(`<span class="radar-chip">暂无新 Signal</span>`);
  return chips.join("");
}

function statusChip(watch) {
  if (watch.status === "paused") return "已暂停";
  if (watch.status === "ended") return "已结束";
  if (watch.latestRun?.status === "running") return "检查中";
  if (watch.latestRun?.status === "failed") return watch.latestRun.coverage?.search === "unavailable" ? "检查不完整" : "检查失败";
  if (watch.status === "active") return "监测中";
  return "观察";
}

function focusTags(focus) {
  const items = (focus?.length ? focus : ["公开信息"]).map((word) => `<span class="radar-tag">${esc(word)}</span>`).join("");
  return `<div class="radar-tags">${items}</div>`;
}

function focusMonitorBlock(watch, modelAvailable) {
  const editable = watch.status !== "ended" && watch.status !== "candidate";
  const focus = watch.scope?.focus?.length ? watch.scope.focus : ["公开信息"];
  const tags = focus.map((word) => {
    if (!editable) return `<span class="radar-tag">${esc(word)}</span>`;
    return `<span class="radar-tag is-editable">${esc(word)}<button type="button" class="radar-tag-remove" data-remove-focus="${esc(word)}" aria-label="移除 ${esc(word)}">×</button></span>`;
  }).join("");
  const retry = modelAvailable && editable
    ? `<button type="button" class="icon-button radar-focus-retry" data-regen-focus aria-label="重新生成" ${pending ? "disabled" : ""}><svg class="icon"><use href="#i-retry"/></svg></button>`
    : "";
  const addForm = editable
    ? `<form class="radar-focus-add" id="radar-focus-add">
        <input name="add" maxlength="16" placeholder="添加维度" autocomplete="off" ${pending ? "disabled" : ""}>
        <button class="quiet-button" type="submit" ${pending === "focus" ? "disabled" : ""}>${pending === "focus" ? "…" : "添加"}</button>
      </form>`
    : "";
  return `
    <div class="is-wide radar-focus-panel">
      <div class="radar-focus-toolbar">
        <span class="radar-focus-label">重点监测</span>
        ${retry}
      </div>
      <div class="radar-focus-body">
        <div class="radar-tags">${tags}</div>
        ${addForm}
      </div>
    </div>`;
}

function shownNarrative(state) {
  if (!state || isSystemNarrative(state.currentNarrative)) return "还没有从证据里形成市场叙事。观察目标仍然是上面的问题。";
  return state.currentNarrative;
}

function shownExpectation(state) {
  if (!state?.expectationKnown) return "未知。现有材料还不能概括一个可核对的市场预期。";
  return state.marketExpectation;
}

function marketLine(state) {
  if (!state || isSystemNarrative(state.currentNarrative)) return "";
  return state.currentNarrative;
}

function isSystemNarrative(narrative) {
  return /尚未形成|已把最近|最近 24|等待第一次|还没有从证据里形成市场叙事/.test(narrative || "");
}

function safeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
  } catch {
    return "";
  }
  return "";
}

function signalCard(signal) {
  const sources = signal.sources.map((source) => `
    <li><a href="${esc(source.url)}" target="_blank" rel="noreferrer">${esc(source.title)}</a>${source.publishedAt ? `<time datetime="${esc(source.publishedAt)}">${esc(dayLabel(source.publishedAt))}</time>` : ""}</li>
  `).join("");
  return `
    <li class="signal-entry">
      <time datetime="${esc(signal.detectedAt)}">${esc(dayLabel(signal.detectedAt))}</time>
      <article class="signal-card">
        <header><strong>${esc(signalTitle(signal))}</strong>${signal.importance === "important" ? `<em>重要</em>` : ""}</header>
        <p>${esc(signal.summary)}</p>
        <div class="signal-shift">
          <div><span>原有状态</span><p>${esc(signal.previousState)}</p></div>
          <b aria-hidden="true">→</b>
          <div><span>这次证据</span><p>${esc(signal.newEvidence)}</p></div>
        </div>
        <p class="signal-impact"><span>对观察的影响</span>${esc(impactSentence(signal))}</p>
        ${sources ? `<ul class="signal-sources">${sources}</ul>` : ""}
      </article>
    </li>
  `;
}

function runRow(run) {
  const when = run.finishedAt || run.startedAt;
  const label = runLabel(run);
  const badgeClass = runBadgeClass(run);
  let text = run.summary || "没有新的结论。";
  if (run.status === "failed") text = `${run.error || "检查没有完成。"} 这次不能判断市场预期有没有变化。`;
  if (run.status === "running") text = "正在检查。";
  const { footnote, turns } = parseRunNote(run.coverage?.note ?? "");
  const materialCount = run.coverage?.evidence?.length ?? run.coverage?.resultCount ?? 0;
  const stats = [
    materialCount > 0 ? `${materialCount} 条引用` : "",
    turns ? `Agent ${turns}` : "",
  ].filter(Boolean).join(" · ");
  const materials = runMaterials(run);
  return `
    <li class="run-entry">
      <article class="run-card ${badgeClass}">
        <header class="run-card-head">
          <span class="run-badge">${esc(label)}</span>
          <time datetime="${esc(when)}">${esc(timeLabel(when))}</time>
        </header>
        <p class="run-conclusion">${esc(text)}</p>
        ${stats ? `<p class="run-stats">${esc(stats)}</p>` : ""}
        ${footnote && footnote !== text && !text.includes(footnote.slice(0, 24)) ? `<p class="run-footnote">${esc(footnote)}</p>` : ""}
        ${materials}
      </article>
    </li>`;
}

function parseRunNote(note) {
  const match = note.match(/（Agent (\d+\/\d+) 轮）/);
  const turns = match?.[1] ?? "";
  const footnote = note.replace(/\s*（Agent \d+\/\d+ 轮）\s*$/, "").trim();
  return { footnote: footnote && !/^[。.]$/.test(footnote) ? footnote : "", turns };
}

function runBadgeClass(run) {
  if (run.status === "failed") return "is-failed";
  if (run.status === "changed") return "is-changed";
  if (runLabel(run) === "基线建立") return "is-baseline";
  if (run.coverage?.judgment === "agent") return "is-agent";
  return "";
}

function runMaterials(run) {
  const list = run.coverage?.evidence ?? [];
  if (!list.length) return "";
  const items = list.map((source) => evidenceItem(source)).join("");
  const open = list.length <= 4 ? " open" : "";
  return `
    <details class="run-evidence-fold"${open}>
      <summary>查看引用 · ${list.length}</summary>
      <ul class="run-evidence-list">${items}</ul>
    </details>`;
}

function evidenceItem(source) {
  const href = safeHttpUrl(source.url);
  const title = href
    ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(source.title)}</a>`
    : `<strong>${esc(source.title)}</strong>`;
  const meta = [source.publisher, source.publishedAt ? dayLabel(source.publishedAt) : ""].filter(Boolean).join(" · ");
  const raw = source.summary?.trim() ?? "";
  const showSummary = raw && raw !== source.title;
  const long = raw.length > 200;
  const summary = showSummary
    ? (long
      ? `<details class="run-evidence-body"><summary>摘要</summary><p>${esc(raw)}</p></details>`
      : `<p class="run-evidence-summary">${esc(raw)}</p>`)
    : "";
  return `
    <li class="run-evidence-item">
      <div class="run-evidence-title">${title}</div>
      ${meta ? `<span class="run-evidence-meta">${esc(meta)}</span>` : ""}
      ${summary}
    </li>`;
}

function runLabel(run) {
  if (run.status === "running") return "正在检查";
  if (run.status === "failed" && run.coverage?.search === "unavailable") return "检查不完整";
  if (run.status === "failed") return "检查失败";
  if (run.coverage?.judgment === "baseline") return "基线建立";
  if (run.coverage?.judgment === "agent" && run.status === "no_change" && (run.coverage.resultCount ?? 0) > 0 && !/Signal|变化/.test(run.summary || "")) {
    return "基线建立";
  }
  if (run.coverage?.judgment === "agent") return "Agent 检查";
  if (run.status === "changed") return "发现新 Signal";
  return "无实质变化";
}

function signalTitle(signal) {
  if (signal.type === "narrative_shift") return "叙事转向";
  if (signal.type === "new_evidence") return "新证据";
  return { bearish: "预期转弱", bullish: "预期转强", mixed: "分歧扩大", neutral: "证据更新" }[signal.direction] || "预期调整";
}

function impactSentence(signal) {
  if (signal.type === "narrative_shift" && signal.direction === "bearish") return "多个独立来源方向一致，市场叙事出现转弱。";
  if (signal.type === "narrative_shift" && signal.direction === "bullish") return "多个独立来源方向一致，市场叙事出现转强。";
  if (signal.impact === "weakens_thesis") return "新增了转弱的证据，还不足以单独确认判断已经改变。";
  if (signal.impact === "supports_thesis") return "新增了转强的证据，还不足以单独确认判断已经改变。";
  return "值得记下，还不能据此改写市场预期。";
}

function tone(attention) {
  if (attention === "近期有新变化") return "is-changed";
  if (attention === "检查失败") return "is-failed";
  return "";
}

async function onClick(event) {
  const button = event.target.closest("button");
  if (!button || pending) return;
  if (button.hasAttribute("data-back")) {
    screen = { kind: "list", id: "" };
    detail = null;
    editingTheme = false;
    menuOpen = false;
    paint();
    return;
  }
  if (button.dataset.open) {
    screen = { kind: "detail", id: button.dataset.open };
    detail = null;
    editingTheme = false;
    detailTab = "snapshot";
    historyVisible = { runs: 5, signals: 5 };
    menuOpen = false;
    paint();
    await load();
    return;
  }
  if (button.dataset.tab) {
    detailTab = button.dataset.tab;
    paint();
    return;
  }
  if (button.hasAttribute("data-menu-toggle")) {
    event.stopPropagation();
    menuOpen = !menuOpen;
    paint();
    return;
  }
  if (button.hasAttribute("data-more-runs")) {
    historyVisible.runs += 8;
    paint();
    return;
  }
  if (button.hasAttribute("data-more-signals")) {
    historyVisible.signals += 5;
    paint();
    return;
  }
  if (button.hasAttribute("data-delete-watch")) {
    event.stopPropagation();
    menuOpen = false;
    if (!window.confirm("删除后，这条观察的主题、检查记录和 Signal 都会从本机移除，且无法恢复。确认删除？")) return;
    await act("delete", async () => {
      await api(`/api/watches/${encodeURIComponent(screen.id)}`, { method: "DELETE" });
      screen = { kind: "list", id: "" };
      detail = null;
      detailTab = "snapshot";
    });
    return;
  }
  if (button.hasAttribute("data-edit-theme")) {
    editingTheme = true;
    paint();
    const field = document.querySelector("#radar-theme-input");
    if (field instanceof HTMLTextAreaElement) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
    return;
  }
  if (button.hasAttribute("data-cancel-theme")) {
    editingTheme = false;
    paint();
    return;
  }
  if (button.hasAttribute("data-refresh")) {
    await act("refresh", async () => { data = await api("/api/watches/candidates", { method: "POST" }); });
    return;
  }
  if (button.dataset.track) {
    await act("track", async () => {
      const created = await api("/api/watches", { method: "POST", body: JSON.stringify({ candidateId: button.dataset.track }) });
      screen = { kind: "detail", id: created.watch.watch.id };
      detail = created.watch;
      detailTab = "snapshot";
      historyVisible = { runs: 5, signals: 5 };
      menuOpen = false;
    });
    return;
  }
  if (button.dataset.dismiss) {
    await act("dismiss", () => api(`/api/watches/${encodeURIComponent(button.dataset.dismiss)}`, { method: "DELETE" }));
    return;
  }
  if (button.hasAttribute("data-remove-focus")) {
    if (!detail?.watch?.scope) return;
    const word = button.getAttribute("data-remove-focus");
    const next = detail.watch.scope.focus.filter((item) => item !== word);
    if (next.length < 1) {
      toast("至少保留一个监测维度。");
      return;
    }
    await act("focus", async () => {
      detail = await api(`/api/watches/${encodeURIComponent(screen.id)}/focus`, { method: "POST", body: JSON.stringify({ focus: next }) });
    });
    return;
  }
  if (button.hasAttribute("data-regen-focus")) {
    await act("focus-regen", async () => {
      detail = await api(`/api/watches/${encodeURIComponent(screen.id)}/focus`, { method: "POST", body: JSON.stringify({ regenerate: true }) });
      toast("已按当前主题重新生成重点监测。");
    });
    return;
  }
  if (button.hasAttribute("data-check")) {
    await runWatchCheck();
    return;
  }
  if (button.dataset.status) {
    menuOpen = false;
    const status = button.dataset.status;
    if (status === "ended" && !window.confirm("结束跟踪后不再自动检查，记录会保留。你仍可在此查看或删除主题。")) return;
    if (status === "paused" && !window.confirm("暂停后不会自动检查，可稍后在菜单中继续跟踪。")) return;
    await act("status", async () => {
      detail = await api(`/api/watches/${encodeURIComponent(screen.id)}/status`, { method: "POST", body: JSON.stringify({ status }) });
    });
  }
}

async function onSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (pending) return;
  if (form.id === "radar-idea") {
    const text = String(new FormData(form).get("text") || "").trim();
    if (text.length < 8) {
      toast("用一句话写下要跟踪的问题。");
      return;
    }
    await act("idea", async () => { data = await api("/api/watches/ideas", { method: "POST", body: JSON.stringify({ text }) }); });
    return;
  }
  if (form.id === "radar-focus-add") {
    const add = String(new FormData(form).get("add") || "").trim();
    if (add.length < 2) {
      toast("监测维度至少 2 个字。");
      return;
    }
    if (add.length > 16) {
      toast("监测维度最多 16 个字。");
      return;
    }
    await act("focus", async () => {
      detail = await api(`/api/watches/${encodeURIComponent(screen.id)}/focus`, { method: "POST", body: JSON.stringify({ add }) });
      form.reset();
    });
    return;
  }
  if (form.id === "radar-theme") {
    const question = String(new FormData(form).get("question") || "").trim();
    if (question.length < 8) {
      toast("主题至少 8 个字。");
      return;
    }
    await act("theme", async () => {
      detail = await api(`/api/watches/${encodeURIComponent(screen.id)}/question`, {
        method: "POST",
        body: JSON.stringify({ question }),
      });
      editingTheme = false;
      toast("主题已更新。下一次检查会按新问题检索。");
    });
  }
}

async function runWatchCheck() {
  if (pending || (detail?.watch && isWatchChecking(detail.watch))) return;
  pending = "check";
  checkLive = { logs: [], thinking: "", tool: null };
  detailTab = "snapshot";
  menuOpen = false;
  if (detail?.watch) {
    detail = {
      ...detail,
      watch: {
        ...detail.watch,
        latestRun: { ...(detail.watch.latestRun || {}), status: "running", summary: "检查中…" },
      },
    };
  }
  paint();
  try {
    const result = await streamWatchCheck(screen.id);
    detail = result.detail;
    toast(result.run.status === "failed" ? (result.run.error || "检查没有完成") : (result.run.summary || "检查完成"));
  } catch (error) {
    toast(error instanceof Error ? error.message : "检查没有完成");
  } finally {
    checkLive = null;
    pending = "";
    await load();
  }
}

async function streamWatchCheck(id) {
  const response = await fetch(`/api/watches/${encodeURIComponent(id)}/check`, {
    method: "POST",
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("检查流没有返回");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (!event) continue;
      if (event.type === "delta" || event.type === "progress") ingestCheckProgress(event.data);
      else if (event.type === "done") donePayload = event.data;
      else if (event.type === "error") throw new Error(event.data.message || "检查失败");
    }
    if (done) break;
  }
  if (!donePayload) throw new Error("检查未正常结束");
  return donePayload;
}

function parseSseBlock(block) {
  let type = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  try {
    return { type, data: JSON.parse(data.join("\n")) };
  } catch {
    return null;
  }
}

async function act(label, fn) {
  if (pending) return;
  pending = label;
  paint();
  try {
    await fn();
  } catch (error) {
    toast(error instanceof Error ? error.message : "没有完成");
  } finally {
    pending = "";
    if (label !== "refresh" && label !== "idea") await load();
    else paint();
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "请求没有完成");
  return body;
}

function dayLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function timeLabel(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
