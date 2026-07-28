/**
 * Radix modal layers lock the page with `pointer-events: none` on <body>; a
 * navigation that unmounts one mid-exit-animation can leave the lock behind,
 * after which every click is a silent no-op. A stale lock is one with no
 * owner: every body-locking vendored primitive marks its portal content with
 * `data-locks-body` (see components/ui — dialog, alert-dialog, sheet,
 * dropdown-menu, select), and that content unmounts on close, so an empty
 * query means no layer legitimately holds the lock. Marker attribute over a
 * role allowlist: roles vary per primitive (menu, dialog, listbox…) and each
 * missed one turns the cleanup into a click-through hole.
 */
export const BODY_LOCK_OWNER_SELECTOR = "[data-locks-body]";

type MinimalDocument = {
  querySelector(selector: string): unknown;
  body: { style: { pointerEvents: string } };
};

/** True when the body is pointer-locked and no open layer owns the lock. */
export function shouldClearBodyLock(doc: MinimalDocument): boolean {
  if (doc.body.style.pointerEvents !== "none") return false;
  return doc.querySelector(BODY_LOCK_OWNER_SELECTOR) === null;
}
