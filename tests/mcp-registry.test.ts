import { describe, expect, it } from "vitest";
import { InvestmentDatabase } from "../src/storage/database.js";
import { createMcpAgentTools, refreshMcpServerTools } from "../src/mcp/agent-tools.js";
import {
  createMcpServer,
  deleteMcpServer,
  mcpEndpoint,
  resolveBriefingMcp,
  toPublicMcp,
  updateMcpServer,
} from "../src/mcp/registry.js";
import type { HttpMcpSession } from "../src/mcp/http-mcp.js";

describe("MCP registry", () => {
  it("seeds Tavily as the system default and rejects deleting it", () => {
    const database = new InvestmentDatabase(":memory:");
    const seeded = database.listMcpServers();
    expect(seeded.map((server) => server.id)).toEqual(["tavily"]);
    expect(toPublicMcp(seeded[0]!)).toMatchObject({
      system: true,
      briefingSearch: true,
      config: {
        name: "Tavily Search",
        url: process.env.TAVILY_MCP_URL?.trim() || "https://mcp.tavily.com/mcp/",
        apiKey: "",
      },
    });

    const disabled = updateMcpServer(database, "tavily", { enabled: false });
    expect(resolveBriefingMcp(database.listMcpServers())).toEqual({ state: "disabled", name: "Tavily Search" });
    expect(disabled.enabled).toBe(false);

    const added = createMcpServer(database, {
      name: "Local notes",
      url: "http://127.0.0.1:8000/mcp",
    });
    expect(added.briefingSearch).toBe(false);
    expect(() => deleteMcpServer(database, "tavily")).toThrow("系统默认");
    deleteMcpServer(database, added.id);
    expect(database.listMcpServers().map((server) => server.id)).toEqual(["tavily"]);
    database.close();
  });

  it("lets Tavily update only the API key, and other MCPs via JSON", () => {
    const database = new InvestmentDatabase(":memory:");
    updateMcpServer(database, "tavily", { apiKey: "secret", enabled: true });
    expect(() => updateMcpServer(database, "tavily", { name: "Hack" })).toThrow("只需设置 API Key");
    expect(database.getMcpServer("tavily")?.name).toBe("Tavily Search");

    const second = createMcpServer(database, {
      name: "Other MCP",
      url: "https://example.com/mcp/",
      apiKey: "other-secret",
      authQueryParam: "token",
    });
    updateMcpServer(database, second.id, {
      name: "Renamed",
      url: "https://example.com/mcp/v2",
      description: "notes",
      authQueryParam: "token",
      apiKey: "",
    });
    const renamed = database.getMcpServer(second.id)!;
    expect(renamed).toMatchObject({
      name: "Renamed",
      endpoint: "https://example.com/mcp/v2",
      description: "notes",
      apiKey: "other-secret",
      briefingSearch: false,
    });
    expect(() => createMcpServer(database, { name: "bad", url: "file:///tmp/mcp" })).toThrow("http 或 https");
    database.close();
  });

  it("exposes every tool from an enabled MCP across Livermore", async () => {
    const database = new InvestmentDatabase(":memory:");
    updateMcpServer(database, "tavily", { enabled: true, apiKey: "secret" });
    const fake: HttpMcpSession = {
      async connect() {},
      async listToolDescriptors() {
        return [{ name: "tavily_search", description: "Search the web", inputSchema: { type: "object", properties: { query: { type: "string" } } } }];
      },
      async callTool() { return { content: [] }; },
      async close() {},
    };
    await refreshMcpServerTools(database, "tavily", () => fake);
    expect(createMcpAgentTools(database.listMcpServers()).map((tool) => tool.name)).toEqual(["tavily_search"]);
    updateMcpServer(database, "tavily", { enabled: false });
    expect(createMcpAgentTools(database.listMcpServers())).toEqual([]);
    expect(mcpEndpoint(database.getMcpServer("tavily")!).searchParams.get("tavilyApiKey")).toBe("secret");
    updateMcpServer(database, "tavily", { apiKey: null });
    await expect(refreshMcpServerTools(database, "tavily")).rejects.toThrow("填写 API Key");
    database.close();
  });
});
