/** Minimal screen router. Pages are rendered into <main id="app">. */

const routes = new Map();
let disposeCurrent = null;
let currentName = null;
/** First paint must not steal focus, otherwise Tab skips the skip link. */
let hasRendered = false;
/** @type {null | ((nextName: string) => boolean)} */
let guard = null;

export function registerRoute(name, factory) {
  routes.set(name, factory);
}

/** Prevents navigation away from a live transfer. Return false to veto. */
export function setRouteGuard(fn) {
  guard = fn;
}

export function currentRoute() {
  return currentName;
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} [params]
 * @param {{ force?: boolean }} [options]
 */
export function navigate(name, params = {}, options = {}) {
  const factory = routes.get(name);
  if (!factory) {
    console.error(`[router] unknown route: ${name}`);
    return false;
  }
  if (!options.force && guard && !guard(name)) return false;

  const root = document.getElementById("app");
  if (!root) return false;

  if (disposeCurrent) {
    try {
      disposeCurrent();
    } catch (error) {
      console.error("[router] dispose failed", error);
    }
    disposeCurrent = null;
  }

  const view = factory(params);
  const element = view?.element ?? view;
  root.replaceChildren(element);
  disposeCurrent = typeof view?.dispose === "function" ? view.dispose : null;
  currentName = name;

  document.title =
    view?.title ? `${view.title} · Droply` : "Droply — Move files. Not limits.";

  // Keep the focus context sane for keyboard and screen-reader users: after an
  // in-app navigation the new screen is announced, but the initial render
  // leaves focus at the document start so the skip link stays first.
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  if (hasRendered && view?.focus !== false) {
    root.focus({ preventScroll: true });
  }
  hasRendered = true;
  return true;
}

/** Clears any rendered screen (used on fatal startup errors). */
export function clear() {
  if (disposeCurrent) disposeCurrent();
  disposeCurrent = null;
  currentName = null;
}
