import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BriefingTask, SourceItem } from "./types.js";

interface DedupeState {
  date: string;
  task: BriefingTask;
  sourceIds: string[];
  updatedAt: string;
}

export class DedupeStore {
  constructor(private readonly directory: string) {}

  async unseen(task: BriefingTask, date: string, sources: SourceItem[]): Promise<SourceItem[]> {
    const state = await this.read(task, date);
    const seen = new Set(state?.sourceIds ?? []);
    return sources.filter((source) => !seen.has(source.id));
  }

  async commit(task: BriefingTask, date: string, sources: SourceItem[], now: Date): Promise<void> {
    const previous = await this.read(task, date);
    const sourceIds = [...new Set([...(previous?.sourceIds ?? []), ...sources.map((source) => source.id)])];
    await mkdir(this.directory, { recursive: true });
    const state: DedupeState = { date, task, sourceIds, updatedAt: now.toISOString() };
    await writeFile(this.filePath(task, date), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private async read(task: BriefingTask, date: string): Promise<DedupeState | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath(task, date), "utf8")) as DedupeState;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return undefined;
      throw error;
    }
  }

  private filePath(task: BriefingTask, date: string): string {
    return path.join(this.directory, `${date}-${task}.json`);
  }
}
