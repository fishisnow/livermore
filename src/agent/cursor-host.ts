// This process hosts the real Pi extension/ModelRuntime, not Cursor CLI. IPC only
// carries Pi protocol events; tools always execute in Livermore's parent Agent.
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SettingsManager, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { CursorHostRequest, CursorHostResponse } from "./cursor-protocol.js";

const directory = process.env.PI_CODING_AGENT_DIR;
if (!directory || process.env.PI_CURSOR_SYSTEM_CREDENTIALS !== "0") {
  throw new Error("Cursor host requires an isolated Livermore credential directory.");
}
const authPath = path.join(directory, "auth.json");
const controllers = new Map<string, AbortController>();
const runtime = initialize();
void runtime.catch(() => {}); // Initialization failures are returned to the caller over IPC.
function send(message: CursorHostResponse): void { if (process.connected) process.send?.(message); }

async function initialize(): Promise<ModelRuntime> {
  await mkdir(directory!, { recursive: true, mode: 0o700 });
  await chmod(directory!, 0o700);
  const models = await ModelRuntime.create({
    authPath, modelsPath: null, modelsStorePath: path.join(directory!, "models-cache.json"), refreshOnCreate: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: directory!, agentDir: directory!, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    disabledBuiltinExtensions: ["llama.cpp", "codemode", "tool-search", "mcp"],
    additionalExtensionPaths: [fileURLToPath(import.meta.resolve("@rahularya01/pi-cursor"))],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length) throw new Error(`Cursor Provider 加载失败：${loaded.errors.map((item) => item.error).join("；")}`);
  // Use Pi's provider composer and OAuth store. Only the explicitly installed
  // Cursor extension may register here; no user/global extensions are discovered.
  const register = (name: string, config: ProviderConfig): void => {
    if (name !== "cursor") throw new Error(`Unexpected Cursor extension provider: ${name}`);
    models.registerProvider(name, { ...config, ...(config.oauth ? { oauth: { ...config.oauth, isSubscription: true } } : {}) });
  };
  for (const entry of loaded.runtime.pendingProviderRegistrations) register(entry.name, entry.config);
  loaded.runtime.registerProvider = register;
  if (!models.getProvider("cursor")) throw new Error("Cursor 扩展没有注册 Pi Provider。");
  return models;
}

function modelFor(models: ModelRuntime, id: string): Model<Api> {
  const model = models.getModel("cursor", id);
  if (model) return model;
  // Keep the user's existing `auto` choice; Cursor resolves it server-side.
  // Unknown explicit model IDs must not silently route to a different model.
  const base = models.getModels("cursor")[0];
  if (id === "auto" && base) return { ...base, id: "auto", name: "Cursor Auto", reasoning: false, thinkingLevelMap: {} };
  throw new Error(`Cursor 模型不可用：${id}。请在设置中刷新可用模型并选择准确的模型 ID。`);
}

async function handle(request: CursorHostRequest): Promise<void> {
  if (request.command === "abort") { controllers.get(request.id)?.abort(); return; }
  const controller = new AbortController();
  controllers.set(request.id, controller);
  try {
    const models = await runtime;
    if (request.command === "catalog") {
      send({ id: request.id, type: "result", value: [...models.getModels("cursor"), modelFor(models, "auto")] });
    } else if (request.command === "status") {
      const auth = await models.checkAuth("cursor");
      send({ id: request.id, type: "result", value: auth ? "Cursor 已登录（Livermore 独立授权）" : "尚未登录。请在设置中点击“登录 Cursor”，完成 Livermore 的浏览器授权。" });
    } else if (request.command === "login") {
      await models.login("cursor", "oauth", {
        signal: controller.signal,
        prompt: async () => { throw new Error("Cursor 登录要求额外输入，请重新发起浏览器授权。"); },
        notify: (event) => { if (event.type === "auth_url") send({ id: request.id, type: "auth_url", url: event.url }); },
      });
      await chmod(authPath, 0o600);
      send({ id: request.id, type: "result", value: "Cursor 浏览器授权成功，凭据仅保存在 Livermore 独立数据目录。" });
    } else if (request.command === "logout") {
      await models.logout("cursor");
      send({ id: request.id, type: "result", value: "已清除 Livermore 的 Cursor 授权，不影响 Cursor IDE 或 CLI。" });
    } else if (request.command === "models") {
      if (!await models.checkAuth("cursor")) throw new Error("请先完成 Livermore 的 Cursor 浏览器授权。");
      await models.refresh({ providers: ["cursor"], allowNetwork: true, force: true, signal: controller.signal });
      const list = models.getModels("cursor").map((model) => `${model.id} - ${model.name}`);
      send({ id: request.id, type: "result", value: ["auto - Cursor Auto", ...list].join("\n") });
    } else if (request.command === "stream") {
      if (!await models.checkAuth("cursor")) throw new Error("Cursor 尚未完成 Livermore 独立授权。请在设置中点击“登录 Cursor”。");
      const stream = models.streamSimple(modelFor(models, request.modelId), request.context, { ...request.options, signal: controller.signal });
      for await (const event of stream) send({ id: request.id, type: "event", event });
      send({ id: request.id, type: "result", value: "complete" });
    }
  } catch (error) {
    send({ id: request.id, type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally { controllers.delete(request.id); }
}

process.on("message", (request: CursorHostRequest) => { void handle(request); });
process.on("disconnect", () => { for (const controller of controllers.values()) controller.abort(); process.exit(0); });
process.on("SIGTERM", () => { for (const controller of controllers.values()) controller.abort(); process.exit(0); });
