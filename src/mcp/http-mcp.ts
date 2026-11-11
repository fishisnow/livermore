import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface HttpMcpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface HttpMcpSession {
  connect(): Promise<void>;
  listToolDescriptors(): Promise<HttpMcpToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>;
  close(): Promise<void>;
}

export function createHttpMcpClient(endpoint: URL): HttpMcpSession {
  const client = new Client({ name: "livermore", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(endpoint);
  return {
    connect: () => client.connect(transport as never),
    async listToolDescriptors() {
      const listed = await client.listTools();
      return listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema && typeof tool.inputSchema === "object"
          ? tool.inputSchema as Record<string, unknown>
          : { type: "object", properties: {} },
      }));
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = Array.isArray(result.content) ? result.content : [];
      return { content, ...(result.isError === true ? { isError: true } : {}) };
    },
    close: () => client.close(),
  };
}

export async function withHttpMcp<T>(
  endpoint: URL,
  run: (session: HttpMcpSession) => Promise<T>,
  create: (endpoint: URL) => HttpMcpSession = createHttpMcpClient,
): Promise<T> {
  const session = create(endpoint);
  try {
    await session.connect();
    return await run(session);
  } finally {
    await session.close();
  }
}
