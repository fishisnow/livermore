import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(root, 'release', 'macos.noindex', 'Livermore.app', 'Contents', 'Resources', 'runtime');
const workspace = await mkdtemp(path.join(tmpdir(), 'livermore-gui-check-'));
await mkdir(path.join(workspace, 'data', 'runtime'), { recursive: true });
await writeFile(path.join(workspace, '.desktop-initialized'), '');
await writeFile(path.join(workspace, '.env'), 'TRACING_ENABLED=false\nTAVILY_MCP_ENABLED=false\nMACOS_NOTIFICATIONS_ENABLED=false\nTASK_SCHEDULER_ENABLED=false\n');
// Synthetic local fixtures only. No model, trading API or message delivery is invoked.
const { InvestmentDatabase } = await import(pathToFileURL(path.join(resources, 'src', 'storage', 'database.js')));
const database = new InvestmentDatabase(path.join(workspace, 'data', 'livermore.db'));
const now = new Date().toISOString();
const report = path.join(workspace, 'data', 'reports', 'visual-check.md');
await mkdir(path.dirname(report), { recursive: true });
await writeFile(report, '# 巡检报告 · 界面测试数据\n\n本报告仅用于界面回归测试，不是真实行情。\n\n## 风险优先级\n\n| 标的 | 风险 | 建议 |\n| --- | --- | --- |\n| 测试标的 A | 警告 | 持有，复核数据 |\n\n> 测试报告不构成投资建议。\n\n```json\n{"source":"synthetic"}\n```\n');
for (const [task, mode] of [['market-briefing', 'pre-market'], ['ai-industry-chain', 'close'], ['portfolio-risk-check', 'hourly']]) {
  const id = database.startRun({ task, mode, scheduledAt: now, idempotencyKey: `visual-${task}` });
  database.succeedRun({ runId: id, reportPath: report, sourceCount: 9, warningCount: 2, usage: { inputTokens: 2400, outputTokens: 1600, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0.012, costCurrency: 'CNY' } });
  database.saveEvaluation(id, 'source-coverage', 1, '通过', '界面测试数据完整。');
  if (task === 'portfolio-risk-check') {
    for (let index = 0; index < 9; index += 1) {
      const position = database.createPosition({ symbol: String(600000 + index), quantity: 100 * (index + 1), purchasedAt: now, costBasis: 20 + index });
      database.savePositionRiskCheck({ runId: id, positionId: position.id, checkedAt: now, name: `测试标的 ${String.fromCharCode(65 + index)}`, currentPrice: 19.8 + index, pnlPct: index % 2 ? 3.42 : -1.25, dayChangePct: index % 2 ? 1.35 : -0.42, severity: index === 2 ? 'critical' : index === 3 ? 'warning' : 'normal', signals: ['界面回归测试，不是真实行情'], rawData: {} });
    }
  }
}
const messageRun = database.listRuns(10).find((run) => run.task === 'portfolio-risk-check');
const message = database.saveAlert(messageRun.id, 'warning', 'Livermore 持仓巡检：测试风险提醒', '## 简明总结\n\n界面测试消息，不是真实行情。\n\n| 优先级 | 标的 | 建议 |\n| --- | --- | --- |\n| P1 | 测试标的 | 持有 |');
database.recordNotification(message, 'macos', 'sent');
database.recordNotification(message, 'feishu', 'failed', '测试投递失败');
database.saveAlert(null, 'info', 'Livermore 每日简报：测试更新', '测试消息：本地消息中心会保存研究摘要。');
const historyA = database.createChat();
database.saveChat(historyA.id, [{ role: 'user', content: '历史会话 A：测试主题' }, { role: 'assistant', content: [{ type: 'text', text: '历史回答 A 已保存。' }] }], 'idle');
const historyB = database.createChat();
database.saveChat(historyB.id, [{ role: 'user', content: '历史会话 B：产业研究' }, { role: 'assistant', content: [{ type: 'text', text: '历史回答 B 已保存。' }] }], 'idle');
database.close();
const output = path.join(workspace, 'native-window');
const application = spawn(path.join(root, 'release', 'macos.noindex', 'Livermore.app', 'Contents', 'MacOS', 'Livermore'), [], {
  env: { ...process.env, LIVERMORE_DESKTOP_WORKSPACE: workspace, LIVERMORE_DESKTOP_SMOKE_OUTPUT: output },
  stdio: 'inherit',
});
const timer = setTimeout(() => application.kill('SIGTERM'), 60_000);
try {
  await new Promise((resolve, reject) => { application.on('error', reject); application.on('exit', resolve); });
  const result = JSON.parse(await readFile(`${output}.json`, 'utf8'));
  assert.equal(result.tasks, 3);
  assert.equal(result.composer, true);
  assert.equal(result.cases.length, 25);
  for (const item of result.cases) {
    assert.equal(item.document.width, item.viewport.width, `${item.name}: horizontal overflow`);
    assert.equal(item.document.height, item.viewport.height, `${item.name}: page overflow`);
    assert.equal(item.frame.x, 0, `${item.name}: outer gutter`);
    assert.equal(item.frame.width, item.viewport.width, `${item.name}: unused window width`);
    assert.equal(item.selected, item.view, `${item.name}: navigation selection`);
    assert.equal(item.theme, item.appearance === 'system' ? item.systemTheme : item.appearance, `${item.name}: theme mismatch`);
    assert.equal(item.nativeAppearance, item.appearance === 'system' ? 'system' : item.appearance === 'dark' ? 'NSAppearanceNameDarkAqua' : 'NSAppearanceNameAqua');
    assert.equal(item.bridge, true);
    assert.equal(item.settingsVisible, true);
    if (item.view === 'chat') {
      assert.ok(item.composer.bottom <= item.viewport.height, `${item.name}: composer clipped`);
      assert.ok(item.composer.width >= 500, `${item.name}: narrow chat`);
    }
    if (item.view === 'portfolio') { assert.equal(item.positions, 9); assert.ok(item.panel); }
    if (item.name.startsWith('compact-')) assert.equal(item.inspector, null, 'compact inspector should auto-hide');
    if (item.name.startsWith('wide-')) assert.ok(item.inspector, 'wide inspector should be visible');
    if (item.name === 'inspector-compact') assert.ok(item.inspector, 'explicit inspector should open');
    if (item.name === 'collapsed-light') assert.equal(item.sidebar.width, 64);
    if (item.name === 'report-dark') { assert.ok(item.report); assert.equal(item.reportTables, 1); }
    if (item.name === 'long-chat-dark') { assert.equal(item.messagesScrollable, true); assert.ok(item.inputHeight <= 160); }
    if (item.name === 'settings-dark') assert.match(item.settingsAppearance, /DarkAqua/);
    if (item.view === 'chat') assert.equal(item.inboxHasTasks, false);
    if (item.name === 'inbox-dark') assert.equal(item.notificationCards, 2);
    if (item.name === 'notification-detail') assert.ok(item.notificationDialog);
    if (item.name === 'task-config-dark') { assert.ok(item.taskEditor); assert.equal(item.taskPromptLoaded, true); assert.ok(item.taskEditor.right <= item.viewport.width); }
    if (item.name === 'task-config-save') { assert.equal(item.taskEditor, null); assert.match(item.taskScheduleText, /已暂停/); }
    if (item.name === 'custom-task-new') { assert.ok(item.taskEditor); assert.equal(item.customNameVisible, true); }
    if (item.name === 'custom-task-saved') { assert.equal(item.taskEditor, null); assert.equal(item.tasks, 4); }
    if (item.name === 'history-open' || item.name === 'history-reopen') { assert.equal(item.visibleChatMessages, 2); assert.equal(item.historyCount, 2); }
    if (item.name === 'history-new') { assert.equal(item.visibleChatMessages, 0); assert.equal(item.historyCount, 2); }
    await access(`${output}-${item.name}.png`);
  }
  await access(`${output}.png`);
  console.log(JSON.stringify({ ...result, screenshot: `${output}.png`, workspace }));
  const edited = await import(pathToFileURL(path.join(resources, 'src', 'tasks', 'task-settings.js')));
  const verifyDb = new InvestmentDatabase(path.join(workspace, 'data', 'livermore.db'));
  const settings = edited.getTaskSettings(verifyDb, 'portfolio-risk-check');
  assert.equal(settings.enabled, false); assert.match(settings.prompt, /界面保存验证/);
  verifyDb.close();
} finally { clearTimeout(timer); }
