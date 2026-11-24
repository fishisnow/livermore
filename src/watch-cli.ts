import { loadConfig } from "./config.js";
import { MessageCenter } from "./notifications/message-center.js";
import { databasePath } from "./project-paths.js";
import { createWatchSearch } from "./watch/search.js";
import { checkWatch, isWatchDue, type SignalNotice } from "./watch/service.js";
import { InvestmentDatabase } from "./storage/database.js";

const config = loadConfig();
const database = new InvestmentDatabase(databasePath);
const messages = new MessageCenter(config, database);

const targets = database.watches.listCheckTargets().filter((target) => isWatchDue({
  status: target.status,
  lastCheckedAt: target.lastCheckedAt,
  latestFinishedAt: target.latestFinishedAt,
  now: new Date(),
  timeZone: config.timezone,
}));

for (const target of targets) {
  try {
    const run = await checkWatch(database, target.id, {
      config,
      search: createWatchSearch(config, database),
      notify: (notice) => notify(notice),
    });
    console.log(`雷达 ${target.id} ${run.status}${run.summary ? `：${run.summary}` : ""}${run.error ? `：${run.error}` : ""}`);
  } catch (error) {
    console.error(`雷达 ${target.id}：${error instanceof Error ? error.message : error}`);
  }
}

database.close();

async function notify(notice: SignalNotice): Promise<void> {
  const sources = notice.sources.map((source) => `- ${source.title}${source.publishedAt ? `（${source.publishedAt.slice(0, 10)}）` : ""} ${source.url}`).join("\n");
  await messages.publish({
    runId: null,
    severity: "warning",
    title: `雷达 · ${notice.question}`,
    body: `${notice.summary}\n\n此前：${notice.previousState}\n新增：${notice.newEvidence}${sources ? `\n\n来源：\n${sources}` : ""}`,
  });
}
