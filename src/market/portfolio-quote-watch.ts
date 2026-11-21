import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { evaluateAtrStopAlert } from "../portfolio/atr-stop-alert.js";
import { resourceRoot } from "../project-paths.js";
import type { InvestmentDatabase } from "../storage/database.js";
import type { MessageInput } from "../notifications/message-center.js";
import { toFutuSecurityCode } from "./normalized-market.js";

const SCRIPT = path.join(resourceRoot, "skills", "futuapi", "scripts", "subscribe", "watch_quotes.py");
const LOCK_PATH = path.join(homedir(), "Library", "Application Support", "Livermore", "data", "runtime", "quote-watch.json");

interface QuoteWatchLock {
  pid: number;
  desktop: boolean;
  at: string;
}

interface WatchedPosition {
  id: string;
  symbol: string;
  name: string | null;
  atrStopLoss: number | null;
  firedAt: string | null;
}

interface WatchEvent {
  type?: string;
  code?: string;
  lastPrice?: number;
  message?: string;
  codes?: string[];
}

/** 本机只让一个 Livermore 进程占用富途订阅。Mac 应用优先于开发服务。 */
export function claimQuoteWatchLock(desktop: boolean, lockPath = LOCK_PATH): boolean {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const current = readQuoteWatchLock(lockPath);
  const heldByOther = current !== null && current.pid !== process.pid && processAlive(current.pid);
  if (heldByOther && !(desktop && !current.desktop)) return false;
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    desktop,
    at: new Date().toISOString(),
  } satisfies QuoteWatchLock), { mode: 0o600 });
  return readQuoteWatchLock(lockPath)?.pid === process.pid;
}

export function releaseQuoteWatchLock(lockPath = LOCK_PATH): void {
  const current = readQuoteWatchLock(lockPath);
  if (current?.pid === process.pid) unlinkSync(lockPath);
}

export class PortfolioQuoteWatch {
  private timer: NodeJS.Timeout | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private positions = new Map<string, WatchedPosition[]>();
  private lastCodes = "";
  private queue = Promise.resolve();
  private stopped = false;
  private nextSpawnAt = 0;
  private lastWarning = "";
  private lastWarningAt = 0;
  private standbyLogged = false;

  constructor(
    private readonly config: AppConfig,
    private readonly database: InvestmentDatabase,
    private readonly publish: (input: MessageInput) => Promise<string>,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.tick();
    }, 5_000);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.stopChild();
    releaseQuoteWatchLock();
  }

  private tick(): void {
    if (this.stopped) return;
    try {
      const desktop = process.env.LIVERMORE_DESKTOP === "1";
      if (!claimQuoteWatchLock(desktop)) {
        this.stopChild();
        if (!this.standbyLogged) {
          console.log("持仓报价监听交给另一个 Livermore 进程。");
          this.standbyLogged = true;
        }
        return;
      }
      this.standbyLogged = false;
      this.reload();
      if (Date.now() < this.nextSpawnAt) return;
      this.ensureChild();
      this.sendCodes();
    } catch (error) {
      this.warn(error instanceof Error ? error.message : String(error));
    }
  }

  private reload(): void {
    const next = new Map<string, WatchedPosition[]>();
    for (const position of this.database.listPositions()) {
      const code = toFutuSecurityCode(position.symbol);
      if (!code) continue;
      const watched = next.get(code) ?? [];
      watched.push({
        id: position.id,
        symbol: position.symbol,
        name: position.latestName,
        atrStopLoss: position.atrStopLoss,
        firedAt: position.atrStopFiredAt,
      });
      next.set(code, watched);
    }
    this.positions = next;
  }

  private ensureChild(): void {
    if (this.child) return;
    const child = spawn(this.config.futuPythonExecutable, [SCRIPT], {
      env: {
        ...process.env,
        FUTU_OPEND_HOST: this.config.futuOpenDHost,
        FUTU_OPEND_PORT: String(this.config.futuOpenDPort),
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.lastCodes = "";
    const output = createInterface({ input: child.stdout });
    output.on("line", (line) => this.handleLine(line.trim()));
    child.stderr.on("data", (chunk) => this.warn(String(chunk).trim()));
    child.on("error", (error) => {
      this.warn(`持仓报价监听启动失败：${error.message}`);
      this.child = undefined;
      this.nextSpawnAt = Date.now() + 15_000;
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.lastCodes = "";
      if (!this.stopped) {
        this.warn(`持仓报价监听已退出（${code ?? "信号"}），15 秒后重试。`);
        this.nextSpawnAt = Date.now() + 15_000;
      }
    });
    child.stdin.on("error", () => {});
  }

  private sendCodes(): void {
    if (!this.child) return;
    const codes = [...this.positions.keys()].sort();
    const line = JSON.stringify({ codes });
    if (line === this.lastCodes) return;
    this.lastCodes = line;
    this.child.stdin.write(`${line}\n`);
  }

  private handleLine(line: string): void {
    if (!line.startsWith("{")) return;
    let event: WatchEvent;
    try {
      event = JSON.parse(line) as WatchEvent;
    } catch {
      return;
    }
    if (event.type === "error" && event.message) {
      this.warn(event.message);
      return;
    }
    if (event.type === "subscribed") {
      const codes = event.codes ?? [];
      console.log(codes.length > 0 ? `持仓报价订阅：${codes.join("、")}` : "持仓报价订阅：无持仓");
      return;
    }
    if (event.type !== "quote" || !event.code || typeof event.lastPrice !== "number") return;
    const watched = this.positions.get(event.code) ?? [];
    for (const item of watched) {
      const decision = evaluateAtrStopAlert(item, event.lastPrice);
      if (!decision) continue;
      if (decision.action === "rearm") {
        this.database.setAtrStopAlertFired(item.id, null);
        item.firedAt = null;
        continue;
      }
      const firedAt = new Date().toISOString();
      this.database.setAtrStopAlertFired(item.id, firedAt);
      item.firedAt = firedAt;
      const price = event.lastPrice;
      this.queue = this.queue
        .then(() => this.publishFire(item, price, decision.stop, firedAt))
        .catch((error) => this.warn(error instanceof Error ? error.message : String(error)));
    }
  }

  private async publishFire(item: WatchedPosition, price: number, stop: number, firedAt: string): Promise<void> {
    const label = item.name ? `${item.name}（${item.symbol}）` : item.symbol;
    try {
      await this.publish({
        runId: null,
        severity: "critical",
        title: `Livermore ATR 止损：${item.name || item.symbol}`,
        body: [
          `${label} 最新价 ${formatPrice(price)}，已触及 ATR 止损 ${formatPrice(stop)}。`,
          "价格回到止损价上方后会重新布防。以上内容仅供研究参考，不构成投资建议，也不会触发交易。",
        ].join("\n"),
      });
    } catch (error) {
      this.database.setAtrStopAlertFired(item.id, null);
      if (item.firedAt === firedAt) item.firedAt = null;
      throw error;
    }
  }

  private stopChild(): void {
    const child = this.child;
    this.child = undefined;
    this.lastCodes = "";
    if (!child) return;
    child.kill("SIGTERM");
  }

  private warn(message: string): void {
    const text = message.replace(/\s+/g, " ").trim();
    if (!text) return;
    const now = Date.now();
    if (text === this.lastWarning && now - this.lastWarningAt < 30_000) return;
    this.lastWarning = text;
    this.lastWarningAt = now;
    console.warn(`持仓报价监听：${text.slice(0, 500)}`);
  }
}

function readQuoteWatchLock(lockPath: string): QuoteWatchLock | null {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<QuoteWatchLock>;
    if (!value || typeof value.pid !== "number" || typeof value.desktop !== "boolean") return null;
    return { pid: value.pid, desktop: value.desktop, at: typeof value.at === "string" ? value.at : "" };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatPrice(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}
