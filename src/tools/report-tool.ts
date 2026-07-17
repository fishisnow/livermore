import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { reportsDirectory } from "../project-paths.js";

const reportParameters = Type.Object({
  name: Type.String({ description: "Short report name without a directory path." }),
  content: Type.String({ description: "Complete Markdown report content." }),
});

export function normalizeReportName(name: string): string {
  const normalized = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  if (!normalized) {
    throw new Error("Report name must contain letters, numbers, or Chinese characters.");
  }
  return `${normalized}.md`;
}

export function createReportTool(): AgentTool<typeof reportParameters> {
  return {
    name: "save_research_report",
    label: "Save research report",
    description: "Save a completed Markdown research report inside the repository-local data/reports directory.",
    parameters: reportParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const filename = normalizeReportName(params.name);
      await mkdir(reportsDirectory, { recursive: true });
      const outputPath = path.join(reportsDirectory, filename);
      await writeFile(outputPath, params.content, { encoding: "utf8", flag: "w" });
      return {
        content: [{ type: "text", text: `Report saved as data/reports/${filename}` }],
        details: { filename },
      };
    },
  };
}
