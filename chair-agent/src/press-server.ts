import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Answered } from "./press-answer.js";
import { cleanQuestion, toPublic, type PressStore } from "./press-store.js";
import { reasoningHash } from "./reasoning.js";

/** The only host the server binds to: only a tunnel on this machine may face the internet. */
export const HOST = "127.0.0.1";

/** The request body cap, in bytes. */
export const MAX_BODY_BYTES = 1024;

export const DEFAULT_LIMITS = {
  perIpCount: 3,
  perIpWindowMs: 10 * 60_000,
  /** What the chain can carry: two answers in each 90 s epoch is 80 an hour. */
  globalCount: 80,
  globalWindowMs: 60 * 60_000,
  /** Answered questions still waiting to be entered in the minutes; past it the desk closes until the agent has caught up. */
  pendingMax: 40,
  /** Questions that may wait for the one model call at a time. */
  queueMax: 5,
} as const;

export type Limits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };

/** The `code` of an error the page can act on: the desk is closed (machine, model or record down) or the press room is full (try again shortly). */
const DESK_CLOSED = { error: "the Chair is not taking questions right now", code: "desk_closed" } as const;
const PRESS_FULL = { error: "the press room is full; try again shortly", code: "press_full" } as const;

const RECORD_DEFAULT = 20;
const RECORD_MAX = 50;

/** The page, and a page served from this machine while it is being built. */
const ALLOWED_ORIGIN = /^(https:\/\/wonkared\.github\.io|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)$/;

/** At most `max` hits per key in the last `windowMs`. */
class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private live(key: string, now: number): number[] {
    const live = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (live.length === 0) this.hits.delete(key);
    else this.hits.set(key, live);
    return live;
  }

  /** Milliseconds until `key` may hit again; 0 when it may now. */
  waitMs(key: string, now: number): number {
    const live = this.live(key, now);
    return live.length < this.max ? 0 : live[live.length - this.max]! + this.windowMs - now;
  }

  hit(key: string, now: number): void {
    this.hits.set(key, [...this.live(key, now), now]);
  }
}

/** One job at a time; at most `maxWaiting` more may wait. */
class SerialQueue {
  private waiting = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly maxWaiting: number) {}

  get hasRoom(): boolean {
    return this.waiting < this.maxWaiting;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    this.waiting++;
    const result = this.tail.then(() => {
      this.waiting--;
      return job();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** An address as a rate-limit key: an IPv4-mapped address is its IPv4, an IPv6 one is its /56 (the block a provider hands one household or one phone). */
function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped !== null) return mapped[1]!;
  if (isIP(ip) !== 6) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::") ? [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  return [...groups.slice(0, 3).map((g) => g.padStart(4, "0")), (groups[3] ?? "0").padStart(4, "0").slice(0, 2)].join(":");
}

/**
 * Who is asking. Behind the tunnel every connection comes from this machine and Cloudflare names the visitor in `CF-Connecting-IP`;
 * a connection from anywhere else is keyed by its own address.
 */
export function clientKey(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  const claimed = req.headers["cf-connecting-ip"];
  return ipKey(loopback && typeof claimed === "string" && isIP(claimed.trim()) !== 0 ? claimed.trim().toLowerCase() : peer);
}

export interface PressServerOptions {
  readonly store: PressStore;
  /** The Chair's answer to a cleaned question; it never throws a reason to the caller. */
  readonly answer: (question: string) => Promise<Answered>;
  /** Whether the Chair is taking questions (the model is up). */
  readonly available: () => boolean;
  readonly limits?: Partial<Limits>;
  readonly now?: () => number;
  /** One line per answered question: id, hash, source. Never the question and never the asker. */
  readonly log?: (line: string) => void;
}

const JSON_TYPE = "application/json; charset=utf-8";

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | number> = {}): void {
  res.writeHead(status, { "content-type": JSON_TYPE, "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(JSON.stringify(body));
}

/** The request body, or null when it is larger than the cap. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return resolve(null);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) resolve(null);
      else chunks.push(c);
    });
    req.on("end", () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

export function createPressServer(opts: PressServerOptions): Server {
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const perIp = new SlidingWindow(limits.perIpCount, limits.perIpWindowMs);
  const global = new SlidingWindow(limits.globalCount, limits.globalWindowMs);
  const queue = new SerialQueue(limits.queueMax);

  async function ask(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
    const bad = (error: string): void => reply(res, 400, { error }, cors);
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return bad("send JSON: content-type application/json");
    const raw = await readBody(req);
    if (raw === null) return reply(res, 400, { error: `the body is over ${MAX_BODY_BYTES} bytes` }, { ...cors, connection: "close" });
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return bad("the body is not JSON");
    }
    const q = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>)["question"] : undefined;
    if (typeof q !== "string") return bad('the body must be {"question": string}');
    const question = cleanQuestion(q);
    if (question === null) return bad("the question must be 1 to 140 characters");

    if (!opts.available()) return reply(res, 503, DESK_CLOSED, cors);
    if (!queue.hasRoom || opts.store.pending().length >= limits.pendingMax) return reply(res, 503, PRESS_FULL, cors);
    const t = now();
    const key = clientKey(req);
    const wait = Math.max(perIp.waitMs(key, t), global.waitMs("all", t));
    if (wait > 0) return reply(res, 429, { error: "too many questions; the Chair has other business" }, { ...cors, "retry-after": Math.ceil(wait / 1000) });
    perIp.hit(key, t);
    global.hit("all", t);

    const entry = await queue.run(async () => {
      const answered = await opts.answer(question);
      return { id: randomUUID(), question, questionHash: reasoningHash(question), answer: answered.answer, source: answered.source, askedAtMs: t };
    });
    try {
      opts.store.add(entry);
    } catch {
      return reply(res, 503, { error: "the record cannot be written; the Chair is not taking questions", code: "desk_closed" }, cors);
    }
    opts.log?.(`answered ${entry.id} ${entry.questionHash.slice(0, 12)} ${entry.source}`);
    reply(res, 200, { id: entry.id, answer: entry.answer, question_hash: entry.questionHash, asked_at_ms: entry.askedAtMs, status: "answered" }, cors);
  }

  function record(url: URL, res: ServerResponse, cors: Record<string, string>): void {
    const param = url.searchParams.get("limit");
    const limit = param === null ? RECORD_DEFAULT : /^\d{1,6}$/.test(param) ? Number(param) : 0;
    if (limit < 1) return reply(res, 400, { error: `limit must be a whole number from 1 to ${RECORD_MAX}` }, cors);
    try {
      reply(res, 200, { taking_questions: opts.available(), entries: opts.store.recent(Math.min(limit, RECORD_MAX)).map(toPublic) }, cors);
    } catch {
      reply(res, 503, { error: "the record cannot be read", code: "desk_closed" }, cors);
    }
  }

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    const cors: Record<string, string> =
      typeof origin === "string" && ALLOWED_ORIGIN.test(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : { vary: "Origin" };
    const url = new URL(req.url ?? "/", "http://localhost");
    const fail = (): void => {
      if (!res.headersSent) reply(res, 503, DESK_CLOSED, cors);
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
      return void res.end();
    }
    const routes: Record<string, { method: string; run: () => void | Promise<void> }> = {
      "/ask": { method: "POST", run: () => ask(req, res, cors) },
      "/record": { method: "GET", run: () => record(url, res, cors) },
      "/health": { method: "GET", run: () => reply(res, 200, { ok: true }, cors) },
    };
    const route = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : undefined;
    if (route === undefined) return reply(res, 404, { error: "not found" }, cors);
    if (req.method !== route.method) return reply(res, 405, { error: "method not allowed" }, { ...cors, allow: route.method });
    Promise.resolve(route.run()).catch(fail);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxConnections = 100;
  return server;
}

/** Listens on 127.0.0.1 only; `port` 0 picks a free one. Resolves with the port. */
export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : port);
    });
  });
}
