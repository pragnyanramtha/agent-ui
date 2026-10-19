import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sent: { endpoint: string; subject: string }[] = [];
vi.mock("web-push", async (orig) => {
  const real = (await orig()) as { default: typeof import("web-push") };
  return {
    default: {
      generateVAPIDKeys: real.default.generateVAPIDKeys,
      sendNotification: async (sub: { endpoint: string }, _payload: string, opts: { vapidDetails: { subject: string } }) => {
        sent.push({ endpoint: sub.endpoint, subject: opts.vapidDetails.subject });
        if (sub.endpoint.includes("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
        if (sub.endpoint.includes("flaky")) throw Object.assign(new Error("busy"), { statusCode: 503 });
        return { statusCode: 201 };
      },
    },
  };
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-push-"));
const file = path.join(dir, "push.json");
let push: typeof import("@/lib/server/push");

beforeAll(async () => {
  process.env.AGENT_U_PUSH = file;
  push = await import("@/lib/server/push");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const sub = (endpoint: string, origin = "https://agent.example") => ({ endpoint, keys: { p256dh: "p", auth: "a" }, origin, ua: "", at: 0 });
const msg = { kind: "done" as const, title: "t", body: "b", tag: "done:x", url: "/" };

describe("push store", () => {
  it("makes one key pair and keeps it private on disk", () => {
    const key = push.vapidPublicKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    push.resetPushCache();
    expect(push.vapidPublicKey()).toBe(key);
  });

  it("keeps one entry per browser", () => {
    push.subscribe(sub("https://push.example/a"));
    push.subscribe(sub("https://push.example/a"));
    push.subscribe(sub("https://push.example/b"));
    expect(push.subscriptionCount()).toBe(2);
    push.unsubscribe("https://push.example/b");
    expect(push.subscriptionCount()).toBe(1);
  });

  it("drops browsers the push service says are gone and keeps ones that failed for now", async () => {
    push.subscribe(sub("https://push.example/gone"));
    push.subscribe(sub("https://push.example/flaky", "http://localhost:3311"));
    sent.length = 0;
    const res = await push.pushAll(msg);
    expect(res).toEqual({ sent: 1, dropped: 1 });
    expect(sent).toHaveLength(3);
    expect(push.subscriptionCount()).toBe(2);
    push.resetPushCache();
    expect(push.subscriptionCount()).toBe(2);
    /* the https origin is the VAPID subject; anything else gets a mailto */
    expect(sent.find((s) => s.endpoint.endsWith("/a"))?.subject).toBe("https://agent.example");
    expect(sent.find((s) => s.endpoint.endsWith("/flaky"))?.subject).toMatch(/^mailto:/);
  });

  it("sees subscriptions another bundle wrote to the file", () => {
    const before = push.subscriptionCount();
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    onDisk.subs.push(sub("https://push.example/other-bundle"));
    fs.writeFileSync(`${file}.x`, JSON.stringify(onDisk));
    fs.renameSync(`${file}.x`, file);
    expect(push.subscriptionCount()).toBe(before + 1);
    push.unsubscribe("https://push.example/other-bundle");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).subs).toHaveLength(before);
  });

  it("can send to one browser only", async () => {
    sent.length = 0;
    await push.pushAll(msg, "https://push.example/a");
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example/a"]);
  });

  it("never replaces a damaged file with new keys", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const key = push.vapidPublicKey();
    const good = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, "{ not json");
    expect(push.vapidPublicKey()).toBe(key);
    expect(warn).toHaveBeenCalledTimes(1);
    push.resetPushCache();
    expect(() => push.vapidPublicKey()).toThrow(/Can't read/);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
    fs.writeFileSync(file, good);
    expect(push.vapidPublicKey()).toBe(key);
    warn.mockRestore();
  });
});
