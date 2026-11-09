// Fullscreen play: hides the browser's tabs, address bar and window title bar.
// Browsers only allow entering it from a click or key press, so the login's
// Begin / Continue buttons (or the Settings toggle) are what trigger it.
import { useEffect, useState } from "react";
import * as storage from "../storage";

const PREF_KEY = "forgebound-fullscreen";

export function fullscreenPref(): boolean {
  try {
    return storage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

export function setFullscreenPref(on: boolean) {
  try {
    storage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    // ignore — the toggle just won't be remembered
  }
}

export const fullscreenSupported = () => !!document.documentElement.requestFullscreen;
const isFullscreen = () => !!document.fullscreenElement;

export function enterFullscreen() {
  if (isFullscreen() || !fullscreenSupported()) return;
  document.documentElement.requestFullscreen().catch(() => {});
}

export function exitFullscreen() {
  if (isFullscreen()) document.exitFullscreen().catch(() => {});
}

/** Live fullscreen state — also follows Esc / F11 exits made outside the game. */
export function useFullscreen(): boolean {
  const [on, setOn] = useState(isFullscreen());
  useEffect(() => {
    const sync = () => setOn(isFullscreen());
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  return on;
}
