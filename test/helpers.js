import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Build a stub `prompts` object for headless wizard runs. Each method pulls its
 * next answer FIFO from the matching array in `responses`.
 */
export function makePrompts(responses = {}) {
  const queues = {};
  for (const [k, v] of Object.entries(responses)) queues[k] = [...v];
  const next = (method) => {
    const q = queues[method];
    if (!q || q.length === 0) {
      throw new Error(`stub prompts: no more answers for "${method}"`);
    }
    return q.shift();
  };
  return {
    input: async () => next("input"),
    select: async () => next("select"),
    checkbox: async () => next("checkbox"),
    confirm: async () => next("confirm"),
    number: async () => next("number"),
  };
}

/** Silent logger for tests. */
export const silentLogger = { log() {}, error() {} };

/** Deterministic seed generator: seed-0, seed-1, ... */
export function makeSeedFn() {
  let i = 0;
  return () => `seed-${i++}`;
}

/** Create and return a fresh temp directory. */
export function tmpDir(prefix = "cfa-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
