import { useCallback, useLayoutEffect, useRef } from "react";

/** A render-stable wrapper around an always-fresh handler.
 *
 *  The returned function's identity never changes, but calling it always
 *  invokes the latest render's version of `fn` — so handlers that close
 *  over state can be passed to `memo`-ized children (each `ListingCard`,
 *  DCH-58) without their identity churn defeating the memo, and without
 *  maintaining a `useCallback` dependency list per handler.
 *
 *  Same contract as the React RFC's `useEvent`: do not call the result
 *  during render — it is for event handlers and effects only.
 */
export function useEvent<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
