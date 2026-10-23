import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { DriverConnection, type ChildLike } from "../src/services/ui-driver-windows.js";
import { DriverError } from "../src/services/ui-driver.js";

class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  lines: string[] = [];
  killed = false;
  exitOnStdinEnd = true;
  constructor() {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => this.lines.push(...chunk.split("\n").filter(Boolean)));
    this.stdin.on("end", () => {
      if (this.exitOnStdinEnd) this.emit("close", 0);
    });
  }
  requests(): Array<Record<string, unknown>> {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  send(text: string | Buffer): void {
    this.stdout.write(text);
  }
  kill(): boolean {
    this.killed = true;
    this.emit("close", 1);
    return true;
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function connect(child: FakeChild, warn = vi.fn()) {
  return { conn: new DriverConnection(child, { commandTimeoutMs: 5_000, closeGraceMs: 1_000, warn }), warn };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DriverConnection", () => {
  it("writes one JSON command per line with an id", async () => {
    const child = new FakeChild();
    const { conn } = connect(child);
    void conn.request("click", { x: 10, y: 20 });
    await tick();
    expect(child.requests()).toEqual([{ id: 1, cmd: "click", x: 10, y: 20 }]);
  });

  it("matches replies to their ids when they arrive out of order", async () => {
    const child = new FakeChild();
    const { conn } = connect(child);
    const a = conn.request<{ id: number; ok: boolean; v: string }>("cursor");
    const b = conn.request<{ id: number; ok: boolean; v: string }>("foreground");
    child.send('{"id":2,"ok":true,"v":"b"}\n{"id":1,"ok":true,"v":"a"}\n');
    expect((await a).v).toBe("a");
    expect((await b).v).toBe("b");
  });

  it("delivers an event that arrives between replies", async () => {
    const child = new FakeChild();
    const { conn } = connect(child);
    const events: string[] = [];
    conn.onEvent((e) => events.push(e));
    const a = conn.request("cursor");
    child.send('{"event":"userInput"}\n{"id":1,"ok":true}\n');
    await a;
    expect(events).toEqual(["userInput"]);
  });

  it("parses a reply and an event split across chunks", async () => {
    const child = new FakeChild();
    const { conn } = connect(child);
    const events: string[] = [];
    conn.onEvent((e) => events.push(e));
    const a = conn.request<{ id: number; ok: boolean; x: number }>("cursor");
    child.send('{"id":1,"ok":tr');
    child.send('ue,"x":5}\n{"eve');
    child.send('nt":"userInput"}\n');
    expect((await a).x).toBe(5);
    await tick();
    expect(events).toEqual(["userInput"]);
  });

  it("keeps non-ASCII text intact, even split inside a character", async () => {
    const child = new FakeChild();
    const { conn } = connect(child);
    const a = conn.request<{ id: number; ok: boolean; text: string }>("typeText");
    const bytes = Buffer.from('{"id":1,"ok":true,"text":"probatikē – κολυμβήθρα"}\n', "utf8");
    const split = bytes.indexOf(Buffer.from("ē", "utf8")) + 1;
    child.send(bytes.subarray(0, split));
    child.send(bytes.subarray(split));
    expect((await a).text).toBe("probatikē – κολυμβήθρα");
  });

  it("ignores a malformed line and warns", async () => {
    const child = new FakeChild();
    const { conn, warn } = connect(child);
    const a = conn.request("cursor");
    child.send("Add-Type : some PowerShell noise\n{\"id\":1,\"ok\":true}\n");
    await a;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Add-Type : some PowerShell noise"));
  });

  it("maps error replies to codes", async () => {
    const child = new FakeChild();
    const { conn } = connect(child);
    const a = conn.request("click", { x: 1, y: 1 });
    const b = conn.request("frob");
    child.send('{"id":1,"ok":false,"error":"foreground_changed"}\n{"id":2,"ok":false,"error":"unknown command: frob"}\n');
    await expect(a).rejects.toMatchObject({ code: "foreground_changed" });
    await expect(b).rejects.toMatchObject({ code: "command", message: "unknown command: frob" });
  });

  it("fails waiting requests when the process exits, and later ones at once", async () => {
    const child = new FakeChild();
    const { conn } = connect(child);
    const a = conn.request("cursor");
    child.stderr.write("first line\nboom\n");
    await tick();
    child.emit("close", 1);
    // Only the last stderr line is kept.
    await expect(a).rejects.toMatchObject({ code: "exited", message: "the input driver stopped (process exited): boom" });
    await expect(conn.request("cursor")).rejects.toMatchObject({
      code: "exited",
      message: "the input driver stopped (process exited): boom",
    });
  });

  it("times a command out after 5 s, then treats the driver as failed and drops the late reply", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { conn } = connect(child);
    const a = conn.request("wheel", { x: 1, y: 1, notches: -6 });
    const caught = a.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await caught).toMatchObject({ code: "timeout", message: '"wheel" got no answer within 5000 ms' });
    const written = child.lines.length;
    await expect(conn.request("cursor")).rejects.toMatchObject({ code: "failed" });
    expect(child.lines.length).toBe(written);
    child.send('{"id":1,"ok":true}\n');
    await vi.advanceTimersByTimeAsync(0);
  });

  // 2026-10-18: a live copy stopped with "the input driver stopped responding"
  // and nothing recorded which command was slow.
  it("warns on stderr naming the command that timed out", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { conn, warn } = connect(child);
    const caught = conn.request("panels").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    await caught;
    expect(warn).toHaveBeenCalledWith('logos-mcp: the input driver gave no answer to "panels" within 5000 ms; treating it as stopped');
  });

  it("warns on stderr when a reply takes more than half its timeout, with the time taken", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { conn, warn } = connect(child);
    const fast = conn.request("cursor");
    await vi.advanceTimersByTimeAsync(2_500);
    child.send('{"id":1,"ok":true}\n');
    await fast;
    expect(warn).not.toHaveBeenCalled();
    const slow = conn.request("wheel");
    await vi.advanceTimersByTimeAsync(3_000);
    child.send('{"id":2,"ok":true}\n');
    await slow;
    expect(warn).toHaveBeenCalledWith('logos-mcp: the input driver took 3000 ms to answer "wheel" (timeout 5000 ms)');
  });

  it("uses a command's own slow threshold when given one", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { conn, warn } = connect(child);
    const within = conn.request("typeText", {}, { slowMs: 3_000 });
    await vi.advanceTimersByTimeAsync(2_900);
    child.send('{"id":1,"ok":true}\n');
    await within;
    expect(warn).not.toHaveBeenCalled();
    const over = conn.request("typeText", {}, { slowMs: 3_000 });
    await vi.advanceTimersByTimeAsync(3_200);
    child.send('{"id":2,"ok":true}\n');
    await over;
    expect(warn).toHaveBeenCalledWith('logos-mcp: the input driver took 3200 ms to answer "typeText" (timeout 5000 ms)');
  });

  it("does not report a command pending when the process exits as a slow answer", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { conn, warn } = connect(child);
    const a = conn.request("panels").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4_000);
    child.emit("close", 1);
    expect(await a).toMatchObject({ code: "exited" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("allows a longer timeout for one command", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { conn } = connect(child);
    const a = conn.request("init", {}, { timeoutMs: 15_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    child.send('{"id":1,"ok":true,"busy":false}\n');
    await expect(a).resolves.toMatchObject({ busy: false });
  });

  it("close() ends stdin and waits for the exit", async () => {
    const child = new FakeChild();
    const { conn } = connect(child);
    await conn.close();
    expect(child.killed).toBe(false);
  });

  it("close() kills the process when it hasn't exited after 1 s", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.exitOnStdinEnd = false;
    const { conn } = connect(child);
    const closing = conn.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;
    expect(child.killed).toBe(true);
  });

  it("delivers a final reply and the stderr reason that arrive just before close", async () => {
    const child = new FakeChild();
    const { conn } = connect(child);
    const a = conn.request<{ id: number; ok: boolean; v: number }>("cursor");
    const b = conn.request("click", { x: 1, y: 1 });
    child.send('{"id":1,"ok":true,"v":7}\n');
    child.stderr.write("Add-Type : compile error\n");
    await tick();
    child.emit("close", 1);
    expect((await a).v).toBe(7);
    await expect(b).rejects.toMatchObject({
      code: "exited",
      message: "the input driver stopped (process exited): Add-Type : compile error",
    });
  });

  it("ignores JSON lines that are not objects and warns", async () => {
    const child = new FakeChild();
    const { conn, warn } = connect(child);
    const a = conn.request("cursor");
    child.send('null\n42\n"text"\n[1]\n{"id":1,"ok":true}\n');
    await a;
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("survives a throwing event listener and keeps processing the chunk", async () => {
    const child = new FakeChild();
    const { conn, warn } = connect(child);
    const seen: string[] = [];
    conn.onEvent(() => {
      throw new Error("listener broke");
    });
    conn.onEvent((e) => seen.push(e));
    const a = conn.request("cursor");
    child.send('{"event":"userInput"}\n{"id":1,"ok":true}\n');
    await a;
    expect(seen).toEqual(["userInput"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("listener broke"));
  });
});
