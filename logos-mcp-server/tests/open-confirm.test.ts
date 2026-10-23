import { describe, it, expect } from "vitest";
import { openAndConfirm, openAndConfirmUnlocked, type OpenConfirmDeps } from "../src/services/open-confirm.js";
import { withUiLock } from "../src/utils/ui-lock.js";
import type { HistoryConfirmation, HistorySnapshotLike, HistoryTarget, HistoryVisit } from "./helpers/open-types.js";

const visit: HistoryVisit = {
  id: "h1",
  title: "PNTC Jn",
  subtitle: "John 5:1",
  lastVisited: "2026-10-17T07:00:00Z",
  kind: "Resource",
  resourceId: "LLS:29.48.20",
  rawReference: "bible.64.5.1",
  reference: "John 5:1",
};
const target: HistoryTarget = { kind: "resource", resourceId: "LLS:29.48.20", reference: "John 5:1" };
const SNAPSHOT: HistorySnapshotLike = { ids: new Set(["old"]), alreadyShowing: null };

function fakeDeps(confirmation: HistoryConfirmation, launchOk = true): { deps: OpenConfirmDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: OpenConfirmDeps = {
    snapshot: () => {
      calls.push("snapshot");
      return SNAPSHOT;
    },
    launch: async (build, options) => {
      calls.push(`launch ${build()} restoreFocus=${String(options?.restoreFocus)}`);
      return launchOk ? { success: true, command: build() } : { success: false, command: "", error: "no handler" };
    },
    wait: async (_t, before) => {
      calls.push(`wait ${before === SNAPSHOT ? "snapshot" : "null"}`);
      return confirmation;
    },
  };
  return { deps, calls };
}

describe("openAndConfirmUnlocked", () => {
  for (const confirmation of [
    { status: "confirmed", visit },
    { status: "already_open", visit },
    { status: "unconfirmed" },
    { status: "unavailable" },
  ] as HistoryConfirmation[]) {
    it(`passes a ${confirmation.status} outcome through`, async () => {
      const { deps, calls } = fakeDeps(confirmation);
      const outcome = await openAndConfirmUnlocked(target, () => "logosres:x", { confirm: true }, deps);
      expect(outcome).toEqual({ launch: { success: true, command: "logosres:x" }, confirmation });
      expect(calls).toEqual(["snapshot", "launch logosres:x restoreFocus=undefined", "wait snapshot"]);
    });
  }

  it("takes no snapshot and waits for nothing when confirm is false", async () => {
    const { deps, calls } = fakeDeps({ status: "confirmed", visit });
    const outcome = await openAndConfirmUnlocked(null, () => "logos4:///Bible/Jn5.1", { confirm: false }, deps);
    expect(outcome.confirmation).toEqual({ status: "unavailable" });
    expect(calls).toEqual(["launch logos4:///Bible/Jn5.1 restoreFocus=undefined"]);
  });

  it("passes restoreFocus through to the launch", async () => {
    const { deps, calls } = fakeDeps({ status: "confirmed", visit });
    await openAndConfirmUnlocked(target, () => "logosres:x", { confirm: true, restoreFocus: false }, deps);
    expect(calls[1]).toBe("launch logosres:x restoreFocus=false");
  });

  it("does not wait for history when the launch failed", async () => {
    const { deps, calls } = fakeDeps({ status: "confirmed", visit }, false);
    const outcome = await openAndConfirmUnlocked(target, () => "logosres:x", { confirm: true }, deps);
    expect(outcome.launch.success).toBe(false);
    expect(outcome.confirmation).toEqual({ status: "unavailable" });
    expect(calls).not.toContain("wait snapshot");
  });
});

describe("openAndConfirm", () => {
  it("waits for the UI lock", async () => {
    const log: string[] = [];
    let release!: () => void;
    const holder = withUiLock(async () => {
      log.push("copy");
      await new Promise<void>((r) => (release = r));
    });
    const { deps } = fakeDeps({ status: "confirmed", visit });
    const open = openAndConfirm(target, () => "logosres:x", { confirm: true }, deps).then(() => log.push("open"));
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual(["copy"]);
    release();
    await Promise.all([holder, open]);
    expect(log).toEqual(["copy", "open"]);
  });
});
