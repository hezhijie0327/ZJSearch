// SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0

/** The homepage hotkeys hint's dismissed flag (localStorage, browser-local —
    deliberately NOT a server preference). One memory for both hero modes.
    Writes dispatch a same-tab event so a live homepage picks a change up
    without a reload — the help modal's re-show action goes through here,
    and the `storage` listener carries cross-tab tabs along. */

import { useEffect, useState } from "react";

const KEY = "zjs-hint-hidden";
const CHANGE = "zjs:hint-change";

export function hintHidden(): boolean {
  return window.localStorage.getItem(KEY) === "1";
}

export function setHintHidden(hidden: boolean): void {
  if (hidden) {
    window.localStorage.setItem(KEY, "1");
  } else {
    window.localStorage.removeItem(KEY);
  }
  window.dispatchEvent(new Event(CHANGE));
}

/** The live view of the flag: initial read + subscription to every writer. */
export function useHotkeyHint(): [boolean, (hidden: boolean) => void] {
  const [hidden, setHidden] = useState(hintHidden);
  useEffect(() => {
    const sync = () => {
      setHidden(hintHidden());
    };
    window.addEventListener(CHANGE, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return [hidden, setHintHidden];
}
