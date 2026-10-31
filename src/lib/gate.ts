import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Many users at once, or one exclusive holder. While the exclusive holder runs, everyone else waits rather than fails.
 * Work already inside the gate may nest, so a connection opened during another connection's work can't deadlock against a waiting holder.
 */
export function createGate() {
  const inside = new AsyncLocalStorage<true>();
  let active = 0, closed: Promise<void> | null = null, idle: (() => void) | null = null;
  const leave = () => { if (--active === 0) idle?.(); };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (inside.getStore()) return fn();
      while (closed) await closed;
      active++;
      try { return await inside.run(true, fn); } finally { leave(); }
    },
    async exclusive<T>(fn: () => Promise<T>, waitMs = 600000): Promise<T> {
      while (closed) await closed;
      let open!: () => void;
      closed = new Promise((r) => { open = r; });
      const release = () => { closed = null; open(); };
      try {
        if (active > 0) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { idle = null; reject(new Error("The warehouse stayed busy for too long, so the build didn't start.")); }, waitMs);
          idle = () => { clearTimeout(timer); idle = null; resolve(); };
        });
        return await fn();
      } finally { release(); }
    },
  };
}
