/* A stand-in for the Agent SDK's query(): tests push the messages a real `claude` would send.
 * Use with vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({ query: (await import("./fake-claude-sdk")).query })). */

type Msg = Record<string, unknown>;

export const fakes: Fake[] = [];

export class Fake {
  queue: Msg[] = [];
  wake: (() => void) | null = null;
  done = false;
  fail: Error | null = null;
  opts: Record<string, any>;
  closed = 0;
  constructor(a: { prompt: AsyncIterable<unknown>; options: Record<string, any> }) {
    this.opts = a.options;
    fakes.push(this);
  }
  push(m: Msg) {
    this.queue.push(m);
    this.wake?.();
  }
  end(err?: Error) {
    this.done = true;
    this.fail = err ?? null;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.done) {
        if (this.fail) throw this.fail;
        return;
      }
      await new Promise<void>((r) => (this.wake = r));
    }
  }
  async interrupt() {}
  close() {
    this.closed++;
    this.end();
  }
  async setModel() {}
  async setPermissionMode() {}
}

export const query = (a: ConstructorParameters<typeof Fake>[0]) => new Fake(a);

export const init = (id: string, extra: Msg = {}) => ({ type: "system", subtype: "init", session_id: id, model: "m", permissionMode: "default", slash_commands: [], ...extra });
