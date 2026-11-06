import type { Api, AssistantMessageEvent, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";

export type CursorCommand = "login" | "logout" | "status" | "models";
export type CursorStreamOptions = Pick<SimpleStreamOptions, "sessionId" | "temperature" | "maxTokens" | "reasoning" | "toolChoice">;
export type CursorHostRequest =
  | { id: string; command: CursorCommand | "catalog" }
  | { id: string; command: "stream"; modelId: string; context: TranscriptContext; options: CursorStreamOptions }
  | { id: string; command: "abort" };
export type CursorHostResponse =
  | { id: string; type: "result"; value: string | Model<Api>[] }
  | { id: string; type: "event"; event: AssistantMessageEvent }
  | { id: string; type: "auth_url"; url: string }
  | { id: string; type: "error"; message: string };
