import { connect as netConnect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { ConnectError, DiscordClientId, SetActivityPayload, TransportError } from "./types.ts";
import { err, ok, type Result } from "./result.ts";

// Seam: everything the rest of the extension knows about Discord. Faked in tests.
export interface DiscordTransport {
  connect(clientId: DiscordClientId, signal?: AbortSignal): Promise<Result<void, ConnectError>>;
  setActivity(payload: SetActivityPayload): Promise<Result<void, TransportError>>;
  clearActivity(): Promise<Result<void, TransportError>>;
  onClose(listener: () => void): void;
  isConnected(): boolean;
  close(): Promise<void>;
}

const classifyConnect = (e: unknown): ConnectError => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/refused|enoent|could not connect|connection|timed?\s*out|timeout|no(t)? running/i.test(msg)) {
    return { type: "DiscordNotRunning" };
  }
  return { type: "HandshakeFailed", detail: msg };
};

// Local fork: speaks Discord's IPC protocol directly over node:net instead of
// @xhayper/discord-rpc, whose @vladfrangu/async_event_emitter dependency throws
// "Attempted to assign to readonly property" at load under Pi-Bolt.
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;
const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;

const ipcPaths = (): string[] => {
  if (process.platform === "win32") {
    return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  }
  const { XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP } = process.env;
  const base = (XDG_RUNTIME_DIR || TMPDIR || TMP || TEMP || "/tmp").replace(/\/$/, "");
  return Array.from({ length: 10 }, (_, i) => `${base}/discord-ipc-${i}`);
};

const encode = (op: number, data: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

const openSocket = (path: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = netConnect(path);
    const onError = (e: Error): void => {
      s.destroy();
      reject(e);
    };
    s.once("error", onError);
    s.once("connect", () => {
      s.off("error", onError);
      resolve(s);
    });
  });

const openFirstSocket = async (): Promise<Socket> => {
  let last: unknown = new Error("ENOENT: no Discord IPC socket");
  for (const path of ipcPaths()) {
    try {
      return await openSocket(path);
    } catch (e) {
      last = e;
    }
  }
  throw last;
};

interface Frame {
  readonly cmd?: string;
  readonly evt?: string;
  readonly nonce?: string;
  readonly data?: { readonly message?: string; readonly code?: number };
}

export const createIpcTransport = (): DiscordTransport => {
  let socket: Socket | undefined;
  let ready = false;
  let closeListener: (() => void) | undefined;
  const pending = new Map<string, (frame: Frame | Error) => void>();

  const teardown = (): void => {
    const wasReady = ready;
    ready = false;
    socket?.destroy();
    socket = undefined;
    for (const settle of pending.values()) settle(new Error("socket closed"));
    pending.clear();
    if (wasReady) closeListener?.();
  };

  const attach = (s: Socket, onFrame: (op: number, frame: Frame) => void): void => {
    let buf = Buffer.alloc(0);
    s.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0);
        const len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        const body = buf.subarray(8, 8 + len).toString("utf8");
        buf = buf.subarray(8 + len);
        let frame: Frame = {};
        try {
          frame = JSON.parse(body) as Frame;
        } catch {
          // malformed frame — ignore
        }
        onFrame(op, frame);
      }
    });
    s.on("error", () => teardown());
    s.on("close", () => teardown());
  };

  const request = async (cmd: string, args: unknown): Promise<Result<void, TransportError>> => {
    const s = socket;
    if (!s || !ready) return err({ type: "SocketClosed" });
    const nonce = randomUUID();
    const reply = await new Promise<Frame | Error>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(nonce);
        resolve(new Error(`${cmd} timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(nonce, (f) => {
        clearTimeout(timer);
        pending.delete(nonce);
        resolve(f);
      });
      s.write(encode(OP_FRAME, { cmd, args, nonce }));
    });
    if (reply instanceof Error) {
      return socket ? err({ type: "SetActivityFailed", detail: reply.message }) : err({ type: "SocketClosed" });
    }
    if (reply.evt === "ERROR") {
      return err({ type: "SetActivityFailed", detail: reply.data?.message ?? "unknown error" });
    }
    return ok(undefined);
  };

  return {
    async connect(clientId, signal) {
      teardown();
      try {
        if (signal?.aborted) throw new Error("connection aborted");
        const s = await openFirstSocket();
        socket = s;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("handshake timed out")), CONNECT_TIMEOUT_MS);
          const onAbort = (): void => reject(new Error("connection aborted"));
          signal?.addEventListener("abort", onAbort, { once: true });
          const done = (e?: Error): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (e) reject(e);
            else resolve();
          };
          attach(s, (op, frame) => {
            if (op === OP_PING) {
              s.write(encode(OP_PONG, frame));
            } else if (op === OP_CLOSE) {
              done(new Error(`handshake rejected: ${frame.data?.message ?? "closed"}`));
              teardown();
            } else if (op === OP_FRAME) {
              if (!ready && frame.cmd === "DISPATCH" && frame.evt === "READY") {
                ready = true;
                done();
              } else if (frame.nonce) {
                pending.get(frame.nonce)?.(frame);
              }
            }
          });
          s.once("close", () => done(new Error("connection closed during handshake")));
          s.write(encode(OP_HANDSHAKE, { v: 1, client_id: clientId }));
        });
        return ok(undefined);
      } catch (e) {
        teardown();
        return err(classifyConnect(e));
      }
    },

    async setActivity(payload) {
      return request("SET_ACTIVITY", {
        pid: process.pid,
        activity: {
          details: payload.details,
          state: payload.state,
          timestamps: { start: payload.startTimestamp },
          assets: {
            large_image: payload.largeImageKey,
            large_text: payload.largeImageText,
            small_image: payload.smallImageKey,
            small_text: payload.smallImageText,
          },
          instance: payload.instance,
        },
      });
    },

    async clearActivity() {
      return request("SET_ACTIVITY", { pid: process.pid });
    },

    onClose(listener) {
      closeListener = listener;
    },

    isConnected() {
      return ready;
    },

    async close() {
      const s = socket;
      ready = false; // explicit close: do not fire closeListener
      if (s) {
        try {
          s.end(encode(OP_CLOSE, {}));
        } catch {
          // best-effort teardown
        }
      }
      teardown();
    },
  };
};
