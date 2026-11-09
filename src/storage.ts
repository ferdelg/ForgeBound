// Storage adapter: one place every save and setting goes through.
//
// Inside Flinsh (window.flinsh present) values live in the Flinsh store, user
// scope, under the same keys the game always used. Standalone, it is plain
// localStorage. The store is async, but the game reads settings synchronously
// all over the place, so initStorage() pulls every ForgeBound key into an
// in-memory cache once at boot; after that reads are sync and writes go to the
// cache immediately and to the store in the background, one write in flight per
// key, coalescing to the latest value.

interface FlinshStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(prefix?: string): Promise<string[]>;
}
declare global {
  interface Window {
    flinsh?: { store?: FlinshStore; ready?: () => void };
  }
}

const PREFIX = "forgebound-";
/** How long to wait for the Flinsh bridge before running standalone. */
const BRIDGE_WAIT_MS = 400;

let store: FlinshStore | null = null;
const cache = new Map<string, string>();
/** The value the store is known to hold per key (null = deleted), to skip no-op writes. */
const lastWritten = new Map<string, string | null>();

// Values are JSON strings in localStorage. In the store they are kept as real
// JSON (objects, numbers) so they are smaller and readable; a value that isn't
// valid JSON is stored as a plain string. Every key the game writes holds JSON.
const toStored = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
const fromStored = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

function waitForBridge(): Promise<boolean> {
  if (window.flinsh) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      window.removeEventListener("flinsh:ready", onReady);
      resolve(false);
    }, BRIDGE_WAIT_MS);
    function onReady() {
      clearTimeout(t);
      resolve(!!window.flinsh);
    }
    window.addEventListener("flinsh:ready", onReady, { once: true });
  });
}

/** Resolve the backend and, under Flinsh, load every saved key. Call once before rendering. */
export async function initStorage(): Promise<"flinsh" | "local"> {
  if (!(await waitForBridge()) || !window.flinsh?.store) return "local";
  store = window.flinsh.store;
  try {
    const keys = (await store.list(PREFIX)).filter((k) => k.startsWith(PREFIX));
    const values = await Promise.all(keys.map((k) => store!.get(k)));
    keys.forEach((k, i) => {
      if (values[i] === null || values[i] === undefined) return;
      const v = fromStored(values[i]);
      cache.set(k, v);
      lastWritten.set(k, v);
    });
  } catch (e) {
    // No permission or the store is down: play on, starting fresh this session.
    console.error("ForgeBound: couldn't load from the Flinsh store", e);
  }
  return "flinsh";
}

// --- background write queue (Flinsh only) ---
const pending = new Map<string, { op: "set"; value: string } | { op: "delete" }>();
const inFlight = new Set<string>();

function pump(key: string) {
  if (!store || inFlight.has(key)) return;
  const job = pending.get(key);
  if (!job) return;
  pending.delete(key);
  const next = job.op === "set" ? job.value : null;
  if (lastWritten.get(key) === next) return; // nothing changed since the last write
  inFlight.add(key);
  const p = job.op === "set" ? store.set(key, toStored(job.value)) : store.delete(key);
  p.then(
    () => lastWritten.set(key, next),
    (e) => {
      lastWritten.delete(key);
      console.error(`ForgeBound: couldn't save "${key}" to the Flinsh store`, e);
    }
  ).finally(() => {
    inFlight.delete(key);
    pump(key);
  });
}

export function getItem(key: string): string | null {
  if (store) return cache.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Returns false only when the write was refused synchronously (localStorage full/blocked). */
export function setItem(key: string, value: string): boolean {
  if (store) {
    cache.set(key, value);
    pending.set(key, { op: "set", value });
    pump(key);
    return true;
  }
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(key: string) {
  if (store) {
    cache.delete(key);
    pending.set(key, { op: "delete" });
    pump(key);
    return;
  }
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
