// Layout of the docked side panel: a column of panes, each holding one or
// more tabs. Kept in a tiny module store (not React state) so the desktop
// column and the mobile drawer show the same layout, and remembered per
// player through the storage adapter (Flinsh store or localStorage).
import { useSyncExternalStore } from "react";
import * as storage from "../storage";

export type TabId = "inv" | "skills" | "prayer" | "quests" | "gear";

export const TAB_LABEL: Record<TabId, string> = { inv: "Inventory", skills: "Skills", prayer: "Prayer", quests: "Quests", gear: "Gear" };
const ALL_TABS: TabId[] = ["inv", "skills", "prayer", "quests", "gear"];

export interface Pane {
  tabs: TabId[];
  active: TabId;
  /** Fixed height in px; undefined sizes the pane to its content. The last pane always fills the rest. */
  height?: number;
}

/** Where a dragged tab lands: into a pane's tab bar, or as a new pane above / below it. */
export type DockTarget = { pane: number; where: "tabs" | "above" | "below" };

const KEY = "forgebound-pane-layout";
const DEFAULT: Pane[] = [{ tabs: [...ALL_TABS], active: "inv" }];

/** Every tab exactly once, no empty panes, a valid active tab in each. */
function normalize(panes: Pane[]): Pane[] {
  const seen = new Set<TabId>();
  const out: Pane[] = [];
  for (const p of panes) {
    const tabs = (p.tabs ?? []).filter((t) => ALL_TABS.includes(t) && !seen.has(t));
    tabs.forEach((t) => seen.add(t));
    if (!tabs.length) continue;
    out.push({ tabs, active: tabs.includes(p.active) ? p.active : tabs[0], height: p.height });
  }
  const missing = ALL_TABS.filter((t) => !seen.has(t));
  if (missing.length) {
    if (out.length) out[0] = { ...out[0], tabs: [...out[0].tabs, ...missing] };
    else out.push({ tabs: missing, active: missing[0] });
  }
  return out;
}

function load(): Pane[] {
  try {
    const raw = storage.getItem(KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch {
    // fall through to the default
  }
  return DEFAULT;
}

let panes: Pane[] = load();
const listeners = new Set<() => void>();

function commit(next: Pane[]) {
  panes = normalize(next);
  try {
    storage.setItem(KEY, JSON.stringify(panes));
  } catch {
    // layout just won't be remembered
  }
  listeners.forEach((l) => l());
}

export function usePaneLayout(): Pane[] {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => panes
  );
}

export function selectTab(pane: number, tab: TabId) {
  commit(panes.map((p, i) => (i === pane ? { ...p, active: tab } : p)));
}

/** Move a tab into another pane's tab bar, or out into a new pane above or below one. */
export function dockTab(tab: TabId, to: DockTarget) {
  const from = panes.findIndex((p) => p.tabs.includes(tab));
  if (from === -1) return;
  // Docking a pane's only tab beside itself would change nothing
  if (to.pane === from && (to.where === "tabs" || panes[from].tabs.length === 1)) return;
  const next = panes.map((p) => ({ ...p, tabs: p.tabs.filter((t) => t !== tab) }));
  if (to.where === "tabs") {
    next[to.pane] = { ...next[to.pane], tabs: [...next[to.pane].tabs, tab], active: tab };
  } else {
    next.splice(to.where === "above" ? to.pane : to.pane + 1, 0, { tabs: [tab], active: tab });
  }
  commit(next);
}

export function setPaneHeight(pane: number, height: number | undefined) {
  commit(panes.map((p, i) => (i === pane ? { ...p, height } : p)));
}

export function resetLayout() {
  commit(DEFAULT);
}
