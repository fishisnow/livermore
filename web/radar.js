let toast = () => {};
let data = null;
let detail = null;
let screen = { kind: "list", id: "" };
let pending = "";
let requestId = 0;
let editingTheme = false;

export function bindRadar(notify) {
  toast = notify;
  const root = document.querySelector("#radar-root");
  if (!root) return;
  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
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
    <p class="radar-lead">AI 提出值得持续验证的问题。你确认后，每天只比较新证据和上次状态。</p>
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
  const latest = detail.signals[0];
  const disagreements = watch.state.uncertainties.length
    ? watch.state.uncertainties.join("、")
    : "还没有从证据里看到明确分歧。";
  const checkButton = watch.status === "active"
    ? `<button class="primary-button" type="button" data-check ${pending ? "disabled" : ""}>${pending === "check" ? "正在检查" : "立即检查"}</button>`
    : watch.status === "paused"
      ? `<button class="primary-button" type="button" data-status="active" ${pending ? "disabled" : ""}>继续跟踪</button>`
      : "";
  const more = watch.status === "ended" ? "" : `
    <details class="radar-more">
      <summary aria-label="更多操作">⋯</summary>
      ${watch.status === "active" ? `<button type="button" data-status="paused" ${pending ? "disabled" : ""}>暂停跟踪</button>` : ""}
      <button type="button" data-status="ended" ${pending ? "disabled" : ""}>结束跟踪</button>
    </details>`;
  const signals = detail.signals.length
    ? `<ol class="signal-timeline">${detail.signals.map(signalCard).join("")}</ol>`
    : `<p class="radar-empty">已建立基线。只有足以改变判断的证据才会出现在这里。</p>`;
  const foot = `
    <div class="radar-foot">
      ${baselineHtml(watch)}
      ${detail.runs.length ? `<details class="radar-fold"><summary>最近检查 · ${detail.runs.length}</summary><ul class="run-log">${detail.runs.map(runRow).join("")}</ul></details>` : ""}
    </div>`;
  const latestBlock = latest
    ? `<div class="radar-latest-box is-hot"><span>最新变化</span><p>${esc(latest.summary)}</p></div>`
    : `<div class="radar-latest-box"><span>最新变化</span><p>暂无</p></div>`;
  return `
    <header class="radar-detail-head">
      <button class="quiet-button radar-back" type="button" data-back>返回</button>
      <div class="radar-toolbar">
        ${checkButton}
        ${more}
      </div>
    </header>
    <section class="radar-hero">
      <div class="radar-chips">${statusChips(watch, detail.signals.length)}</div>
      ${themeBlock(watch)}
      ${failed ? `<p class="radar-alert">${esc(failed.error || "这次检查没有完成。")} 这次不能判断市场预期有没有变化。</p>` : ""}
    </section>
    <section class="radar-snapshot">
      <p class="radar-snapshot-lead">${esc(shownNarrative(watch.state))}</p>
      ${latestBlock}
      <dl class="radar-meta">
        <div><dt>市场预期</dt><dd>${esc(shownExpectation(watch.state))}</dd></div>
        <div><dt>关键分歧</dt><dd>${esc(disagreements)}</dd></div>
        <div class="is-wide"><dt>重点监测</dt><dd>${focusTags(watch.scope.focus)}</dd></div>
      </dl>
    </section>
    <section class="radar-block">
      <div class="radar-block-head"><span>Signal 时间线</span><span>${detail.signals.length}</span></div>
      ${signals}
    </section>
    ${foot}
  `;
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
  if (watch.latestRun?.status === "failed") return watch.latestRun.coverage?.search === "unavailable" ? "检查不完整" : "检查失败";
  if (watch.status === "active") return "监测中";
  return "观察";
}

function focusTags(focus) {
  const items = (focus?.length ? focus : ["公开信息"]).map((word) => `<span class="radar-tag">${esc(word)}</span>`).join("");
  return `<div class="radar-tags">${items}</div>`;
}

function baselineHtml(watch) {
  const sources = baselineSources(watch);
  if (!watch.state.baselined) {
    return `<p class="radar-empty">还没有基线。第一次检查成功后，证据支持的市场状态会写在上面，来源收在这里。</p>`;
  }
  if (sources.length === 0) {
    return `<p class="radar-empty">基线里没有留下与观察问题相关的来源。</p>`;
  }
  const items = sources.map((source) => {
    const href = safeHttpUrl(source.url);
    const title = href ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(source.title)}</a>` : `<strong>${esc(source.title)}</strong>`;
    const meta = [source.publisher, source.publishedAt ? dayLabel(source.publishedAt) : "日期不明"].filter(Boolean).join(" · ");
    const summary = source.summary && source.summary !== source.title ? `<p>${esc(source.summary)}</p>` : "";
    return `<li>${title}<span class="baseline-meta">${esc(meta)}</span>${summary}</li>`;
  }).join("");
  return `
    <details class="radar-fold">
      <summary>基线来源 · ${sources.length}</summary>
      <p class="radar-note">这些是建立基线时用过的公开信息，本身不是变化。</p>
      <ul class="baseline-list">${items}</ul>
    </details>
  `;
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

function baselineSources(watch) {
  const saved = watch.state.baselineSources ?? [];
  if (saved.length > 0) return saved;
  if (!watch.state.baselined) return [];
  return (watch.state.knownEvidence ?? []).map((item) => ({
    title: item.title,
    url: item.url,
    summary: "",
    publishedAt: item.publishedAt,
    publisher: "",
  }));
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
  let text = run.summary || "没有新的结论。";
  if (run.status === "failed") text = `${run.error || "检查没有完成。"} 这次不能判断市场预期有没有变化。`;
  if (run.status === "running") text = "正在检查。";
  return `<li><time datetime="${esc(when)}">${esc(timeLabel(when))}</time><span><em>${esc(runLabel(run))}</em>${esc(text)}</span></li>`;
}

function runLabel(run) {
  if (run.status === "running") return "正在检查";
  if (run.status === "failed" && run.coverage?.search === "unavailable") return "检查不完整";
  if (run.status === "failed") return "检查失败";
  if (run.coverage?.judgment === "baseline") return "基线建立成功";
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
    paint();
    return;
  }
  if (button.dataset.open) {
    screen = { kind: "detail", id: button.dataset.open };
    detail = null;
    editingTheme = false;
    paint();
    await load();
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
    });
    return;
  }
  if (button.dataset.dismiss) {
    await act("dismiss", () => api(`/api/watches/${encodeURIComponent(button.dataset.dismiss)}`, { method: "DELETE" }));
    return;
  }
  if (button.hasAttribute("data-check")) {
    await act("check", async () => {
      const result = await api(`/api/watches/${encodeURIComponent(screen.id)}/check`, { method: "POST" });
      detail = result.detail;
      toast(result.run.status === "failed" ? (result.run.error || "检查没有完成") : (result.run.summary || "检查完成"));
    });
    return;
  }
  if (button.dataset.status) {
    if (button.dataset.status === "ended" && !window.confirm("结束跟踪后，每天不再检查。已有的变化记录会留着。")) return;
    const status = button.dataset.status;
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
