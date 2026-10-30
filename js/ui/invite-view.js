/**
 * Incoming nearby / saved-device invite.
 *
 * Nothing is joined and nothing is accepted automatically: the user sees who
 * asked, whether that identity matches a saved device, and has to choose.
 */

import { el, iconsIn, qs } from "./common.js";
import { deviceAvatarMarkup } from "./device-avatar.js";

/**
 * @param {{
 *   name: string,
 *   deviceType?: string,
 *   avatar?: string,
 *   verified: boolean,
 *   reason?: string,
 *   onAccept: () => void,
 *   onReject: () => void
 * }} options
 */
export function mountInvite({ name, deviceType = "", avatar = "", verified, reason = "", onAccept, onReject }) {
  let busy = false;

  const element = el(`
    <section class="screen" aria-labelledby="invite-title">
      <div class="stage stage--narrow">
        <div class="screen-head screen-head--center">
          <span class="pill ${verified ? "pill--success" : "pill--blue"}">
            <span class="status-dot status-dot--live" aria-hidden="true"></span>
            Nearby request
          </span>
          <h1 id="invite-title">A device wants to send you files</h1>
          <p>Nothing has been transferred. You will still review the file list before accepting.</p>
        </div>

        <div class="card consent">
          <div class="consent__head">
            ${deviceAvatarMarkup(avatar, { size: "lg" })}
            <div>
              <div class="consent__title" data-name></div>
              <div class="consent__sub" data-sub></div>
            </div>
          </div>

          ${
            verified
              ? `<div class="alert alert--success">
                   <i data-icon="shield-check" data-size="16"></i>
                   <span>This request is signed by a saved device. The signature was verified in this browser.</span>
                 </div>`
              : `<div class="alert alert--warning">
                   <i data-icon="shield-alert" data-size="16"></i>
                   <span>This device isn't saved on this browser. Only continue if you know who sent it.</span>
                 </div>`
          }

          <div class="alert alert--danger alert--rich" data-error role="alert" hidden>
            <i data-icon="circle-alert" data-size="16"></i>
            <span class="alert__body" data-error-text></span>
          </div>

          <div class="btn-group btn-group--end">
            <button type="button" class="btn btn--secondary" data-reject>Reject</button>
            <button type="button" class="btn btn--blue btn--lg" data-accept>
              <i data-icon="download" data-size="17"></i> Review files
            </button>
          </div>
        </div>

        <p class="stage-note">
          The room code from this invite is one-time and expires in minutes. File bytes never pass
          through the nearby service.
        </p>
      </div>
    </section>
  `);

  qs(element, "[data-name]").textContent = name || "Unknown device";
  qs(element, "[data-sub]").textContent = deviceType
    ? `${deviceType}${reason ? ` · ${reason}` : ""}`
    : reason || "Asking to start a transfer";
  iconsIn(element);

  const acceptBtn = qs(element, "[data-accept]");
  const rejectBtn = qs(element, "[data-reject]");
  const errorBox = qs(element, "[data-error]");
  const errorText = qs(element, "[data-error-text]");

  function fail(message) {
    busy = false;
    acceptBtn.disabled = false;
    rejectBtn.disabled = false;
    acceptBtn.innerHTML = `<i data-icon="download" data-size="17"></i> Review files`;
    iconsIn(acceptBtn);
    if (message) {
      errorText.textContent = message;
      errorBox.hidden = false;
    }
  }

  acceptBtn.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    acceptBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Joining…</span>`;
    onAccept();
  });

  rejectBtn.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    onReject();
  });

  return { element, title: "Transfer request", fail };
}
