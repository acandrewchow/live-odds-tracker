import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const FIXTURES: Record<string, Buffer> = {
  "88808": readFileSync(join(root, "test/fixtures/nfl.json")),
  "84240": readFileSync(join(root, "test/fixtures/mlb.json")),
};

/**
 * A stand-in for DraftKings that we can break on demand.
 *
 * `mode` decides what the next request gets, so a test can knock the upstream
 * over mid-run and assert the app degrades rather than dies.
 */
export type Mode = "ok" | "503" | "html" | "truncated" | "hang";

export class FakeDraftKings {
  private server?: Server;
  /** Live sockets, so shutdown does not wait on keep-alive connections. */
  private sockets = new Set<import("node:net").Socket>();
  /** Every request timestamp, so tests can assert the upstream request rate. */
  hits: number[] = [];
  mode: Mode = "ok";
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.hits.push(Date.now());
      const league = new URL(req.url ?? "", "http://x").searchParams.get("league") ?? "88808";

      switch (this.mode) {
        case "503":
          res.writeHead(503).end("upstream down");
          return;
        case "html":
          res.writeHead(200, { "Content-Type": "text/html" }).end("<html>Access Denied</html>");
          return;
        case "truncated":
          res.writeHead(200, { "Content-Type": "application/json" }).end('{"events":[{"id":');
          return;
        case "hang":
          return; // never responds; exercises the fetch timeout
        default:
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end(FIXTURES[league] ?? FIXTURES["88808"]);
      }
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((r) => this.server!.listen(0, r));
    this.port = (this.server!.address() as { port: number }).port;
  }

  /** Requests received since a marker, for rate assertions. */
  since(mark: number): number {
    return this.hits.length - mark;
  }
  mark(): number {
    return this.hits.length;
  }

  async stop(): Promise<void> {
    // The app holds keep-alive connections open, so `close()` alone would wait
    // forever. Destroy them first, or the test process never exits.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}

export class AppServer {
  private proc?: ChildProcess;
  private log: string[] = [];
  port = 0;
  base = "";

  async start(env: Record<string, string>): Promise<void> {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, r));
    this.port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    this.base = `http://127.0.0.1:${this.port}`;

    this.proc = spawn("npx", ["next", "start", "-p", String(this.port)], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    this.proc.stdout?.on("data", (d: Buffer) => this.log.push(d.toString()));
    this.proc.stderr?.on("data", (d: Buffer) => this.log.push(d.toString()));

    // Poll until it answers rather than sleeping a fixed amount.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.base}/league/nfl`);
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(
      `app server did not start within 60s. Child output:\n${this.log.join("") || "(none)"}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.proc?.pid) return;
    const p = this.proc;
    await new Promise<void>((resolve) => {
      const done = () => {
        p.stdout?.destroy();
        p.stderr?.destroy();
        resolve();
      };
      p.once("exit", done);
      try {
        // Negative pid targets the whole group, taking next-server with it.
        process.kill(-p.pid!, "SIGKILL");
      } catch {
        p.kill("SIGKILL");
      }
      setTimeout(done, 3000).unref();
    });
  }
}

/** Reads SSE frames off a stream until `want` frames arrive or `ms` elapses. */
export async function readSse(
  url: string,
  opts: { want?: number; ms?: number } = {},
): Promise<{ frames: unknown[]; keepalives: number; contentType: string | null }> {
  const { want = 1, ms = 15_000 } = opts;
  const res = await fetch(url);
  const contentType = res.headers.get("content-type");
  const frames: unknown[] = [];
  let keepalives = 0;
  if (!res.body) return { frames, keepalives, contentType };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + ms;

  while (Date.now() < deadline && frames.length < want) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (raw.startsWith(":")) {
        keepalives++;
        continue;
      }
      const at = raw.indexOf("data: ");
      if (at !== -1) frames.push(JSON.parse(raw.slice(at + 6)));
    }
  }
  await reader.cancel().catch(() => {});
  return { frames, keepalives, contentType };
}
