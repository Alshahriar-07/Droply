/**
 * Reusable error surfaces.
 *
 * One component renders every full-page failure, and two small helpers cover
 * the inline (inside a card) and toast cases, so error copy and structure stay
 * identical everywhere. The copy itself always comes from core/errors.js.
 */

import { el, escapeHtml, iconsIn, qs, toast } from "./common.js";
import { describeError, ERROR_SCOPE, getErrorSpec } from "../core/errors.js";

/**
 * Full-page error.
 *
 * @param {{
 *   id: string,
 *   detail?: string,
 *   diagnostic?: string,
 *   actions?: Array<{label: string, variant?: string, icon?: string, onClick: () => void}>,
 *   onBack?: () => void
 * }} options
 */
export function mountErrorPage({ id, detail = "", diagnostic = "", actions = [], onBack }) {
  const spec = describeError(id, { detail });
  const shownRef = spec.ref;
  const stamp = new Date().toISOString().replace("T", " ").replace(/\..+$/, " UTC");

  const element = el(`
    <section class="screen error-screen" aria-labelledby="error-title">
      <div class="stage stage--narrow">
        <div class="error-head">
          <span class="error-head__badge" aria-hidden="true">
            <i data-icon="${escapeHtml(spec.icon)}" data-size="22"></i>
          </span>
          <span class="error-head__ref mono">${escapeHtml(shownRef)}</span>
        </div>

        <div class="error-copy">
          <h1 id="error-title" tabindex="-1">${escapeHtml(spec.title)}</h1>
          <p class="error-copy__message">${escapeHtml(spec.message)}</p>
          ${detail ? `<p class="error-copy__detail">${escapeHtml(detail)}</p>` : ""}
        </div>

        ${
          spec.recovery.length
            ? `<div class="card error-recovery">
                 <span class="code-label">What you can do</span>
                 <ol class="error-steps">
                   ${spec.recovery
                     .map(
                       (step, index) =>
                         `<li><span class="error-steps__index mono">${index + 1}</span><span>${escapeHtml(step)}</span></li>`,
                     )
                     .join("")}
                 </ol>
               </div>`
            : ""
        }

        <div class="btn-group error-actions" data-actions></div>

        <details class="error-details">
          <summary>Technical details</summary>
          <dl>
            <div><dt>Reference</dt><dd class="mono">${escapeHtml(shownRef)}</dd></div>
            ${diagnostic ? `<div><dt>Diagnostic ID</dt><dd class="mono">${escapeHtml(diagnostic)}</dd></div>` : ""}
            <div><dt>Reported</dt><dd class="mono">${escapeHtml(stamp)}</dd></div>
            <div><dt>Recoverable</dt><dd>${spec.retryable ? "Yes — retrying may help" : "No — a new attempt is required"}</dd></div>
          </dl>
          <p class="error-details__note">
            Droply never records transfer codes, tokens or file contents in this report.
          </p>
        </details>

        ${
          onBack
            ? `<button type="button" class="btn btn--ghost btn--sm error-back" data-back>
                 <i data-icon="arrow-left" data-size="16"></i> Back to home
               </button>`
            : ""
        }
      </div>
    </section>
  `);

  const host = qs(element, "[data-actions]");
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn btn--${action.variant ?? "primary"}`;
    if (action.icon) button.innerHTML = `<i data-icon="${escapeHtml(action.icon)}" data-size="16"></i>`;
    button.appendChild(document.createTextNode(action.label));
    button.addEventListener("click", action.onClick);
    host.appendChild(button);
  }
  host.hidden = actions.length === 0;

  qs(element, "[data-back]")?.addEventListener("click", onBack);

  iconsIn(element);

  // The router has already swapped the old screen out, so focus would
  // otherwise fall back to <body>. Move it to the headline so the failure is
  // announced straight away, without trapping keyboard users.
  window.setTimeout(() => element.querySelector("h1")?.focus({ preventScroll: true }), 0);

  return { element, title: spec.title, focus: false };
}

/**
 * Inline error block for a card. Same copy, smaller footprint.
 *
 * @param {string} id Catalog id.
 * @param {{ detail?: string }} [options]
 * @returns {string} HTML string; hydrate it with iconsIn().
 */
export function inlineErrorMarkup(id, options = {}) {
  const spec = describeError(id, { detail: options.detail });
  return `
    <div class="alert alert--danger alert--rich" role="alert">
      <i data-icon="${escapeHtml(spec.icon)}" data-size="16"></i>
      <span class="alert__body">
        <strong>${escapeHtml(spec.title)}</strong>
        <span>${escapeHtml(spec.message)}</span>
      </span>
    </div>
  `;
}

/**
 * Toast for failures that only need a nudge (cancellation, blocked download).
 *
 * @param {string} id Catalog id.
 * @param {{ tone?: string, detail?: string }} [options]
 */
export function errorToast(id, options = {}) {
  const spec = describeError(id, { detail: options.detail });
  const tone = options.tone ?? (spec.retryable ? "danger" : "default");
  toast(spec.title, { tone });
  return spec;
}

/** True when an id should be rendered as a full page rather than inline. */
export function isPageError(id) {
  return getErrorSpec(id).scope === ERROR_SCOPE.PAGE;
}
