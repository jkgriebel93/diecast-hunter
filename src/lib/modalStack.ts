/** Which modals are open, innermost last (DCH-32).
 *
 *  Two things need to know about nesting, and neither can work it out
 *  locally:
 *
 *  - **Escape must close only the topmost dialog.** Every open `Modal` has a
 *    `keydown` listener on `window`, so without a shared notion of "am I on
 *    top", one Escape collapses the whole stack.
 *  - **The z-layer has to be derived, not declared.** `GroupEditorDialog` is
 *    rendered both on its own (from the Listings toolbar) and from inside
 *    `GroupsModal`. A `layer` prop would have to be passed differently at
 *    each site and would be wrong the first time someone added a third.
 *
 *  Kept as a plain module rather than React context because it is genuinely
 *  global — a dialog rendered from anywhere in the tree stacks above one
 *  rendered anywhere else — and because a module of pure functions is
 *  directly unit-testable, which the `useEffect` that drives it is not.
 */

let stack: string[] = [];

/** Register an open modal. Ignores a repeat push of the same id so React's
 *  double-invoked effects in StrictMode can't corrupt the depth. */
export function pushModal(id: string): void {
  if (stack.includes(id)) return;
  stack.push(id);
}

/** Deregister. Safe to call for an id that isn't present. */
export function popModal(id: string): void {
  stack = stack.filter((entry) => entry !== id);
}

/** True when `id` is the innermost open modal — i.e. the one Escape and a
 *  backdrop click should act on. False for an unknown id, so a modal that
 *  somehow missed registration stays inert rather than stealing the key. */
export function isTopmost(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** How many modals are open beneath `id`. 0 for the outermost. Returns 0 for
 *  an unregistered id — the base layer is the safe default. */
export function depthOf(id: string): number {
  const i = stack.indexOf(id);
  return i < 0 ? 0 : i;
}

export function openCount(): number {
  return stack.length;
}

/** Tests only. The stack outlives any single component, so a leaked entry
 *  from one test would silently change what the next one asserts. */
export function resetModalStack(): void {
  stack = [];
}
