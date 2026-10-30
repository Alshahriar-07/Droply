/**
 * Device Profile screen.
 *
 * Shows the one identity this browser uses everywhere: avatar, generated name,
 * coarse type/OS/browser, a short public fingerprint and the actions that edit
 * them. The four-digit tag is a display discriminator, not a credential.
 */

import { avatarPickerMarkup, deviceAvatarMarkup } from "./device-avatar.js";
import { el, qs } from "./common.js";
import { formatDeviceSubtitle } from "../core/device-profile.js";

function formatFingerprint(value) {
  const clean = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return clean.replace(/(.{4})(?=.)/g, "$1 ");
}

/**
 * @param {{
 *   identityPromise: Promise<object>,
 *   onBack: () => void,
 *   onUpdate: (patch: { name?: string, avatar?: string, regenerateSuffix?: boolean }) => Promise<object|void>
 * }} options
 */
export function mountProfile({ identityPromise, onBack, onUpdate }) {
  /** @type {object|null} */
  let identity = null;
  let busy = false;
  let confirmingReset = false;

  const element = el(`
    <section class="screen" aria-labelledby="profile-title">
      <div class="stage stage--narrow">
        <div class="back-row">
          <button type="button" class="btn btn--ghost btn--sm" data-back>
            <i data-icon="arrow-left" data-size="16"></i> Back
          </button>
          <span class="pill"><i data-icon="user" data-size="13"></i> This device</span>
        </div>

        <div class="screen-head">
          <h1 id="profile-title">Device profile</h1>
          <p>This is how your device appears in pairing, nearby discovery and every transfer.</p>
        </div>

        <div class="card card--padded profile-card">
          <div class="profile-head">
            <span data-identity data-fallback="true">
              <span class="device-avatar device-avatar--generic device-avatar--xl" aria-hidden="true"></span>
            </span>
            <div class="profile-head__body">
              <h2 class="profile-name" data-name>Detecting device…</h2>
              <p class="profile-sub" data-subtitle>Reading platform and browser</p>
            </div>
          </div>

          <dl class="profile-details">
            <div>
              <dt>Device type</dt>
              <dd data-device-type>—</dd>
            </div>
            <div>
              <dt>Operating system</dt>
              <dd data-platform>—</dd>
            </div>
            <div>
              <dt>Browser</dt>
              <dd data-browser>—</dd>
            </div>
            <div>
              <dt>Device identifier</dt>
              <dd class="mono" data-fingerprint title="Derived from this device's public key">—</dd>
            </div>
          </dl>

          <div class="btn-group" data-actions>
            <button type="button" class="btn btn--secondary btn--sm" data-edit-name>
              <i data-icon="pencil" data-size="15"></i> Edit device name
            </button>
            <button type="button" class="btn btn--secondary btn--sm" data-edit-avatar>
              <i data-icon="monitor" data-size="15"></i> Change avatar
            </button>
          </div>

          <form class="profile-form" data-name-form hidden novalidate>
            <label class="code-label" for="device-name">Device name</label>
            <div class="profile-form__row">
              <input id="device-name" type="text" maxlength="40" data-name-input
                autocomplete="off" spellcheck="false" aria-describedby="device-name-hint" />
              <button type="submit" class="btn btn--primary btn--sm">Save</button>
              <button type="button" class="btn btn--ghost btn--sm" data-name-cancel>Cancel</button>
            </div>
            <p class="panel__hint" id="device-name-hint">
              Up to 40 characters. Peers see this name, so avoid anything private.
            </p>
          </form>

          <div class="profile-avatar-panel" data-avatar-panel hidden>
            <span class="code-label">Choose an avatar</span>
            <div data-avatar-options></div>
            <button type="button" class="btn btn--ghost btn--sm" data-avatar-cancel>Close</button>
          </div>

          <div class="profile-tag">
            <div>
              <span class="code-label">4-digit tag</span>
              <p class="profile-tag__text">
                Keeps two devices with the same platform apart. It is a label, never a password.
              </p>
            </div>
            <div class="btn-group">
              <span class="pill mono" data-tag aria-label="Current 4-digit tag">—</span>
              <button type="button" class="btn btn--ghost btn--sm" data-regenerate>
                <i data-icon="rotate-cw" data-size="14"></i> New tag
              </button>
            </div>
          </div>

          <div class="profile-confirm" data-reset-confirm hidden>
            <p>
              A new tag changes this device's name to a new default. Saved devices keep
              working — your keys and device ID do not change.
            </p>
            <div class="btn-group">
              <button type="button" class="btn btn--primary btn--sm" data-reset-confirm-button>
                Generate new tag
              </button>
              <button type="button" class="btn btn--ghost btn--sm" data-reset-cancel>Cancel</button>
            </div>
          </div>

          <div class="alert alert--danger alert--rich" data-error role="alert" hidden>
            <i data-icon="circle-alert" data-size="16"></i>
            <span class="alert__body" data-error-text></span>
          </div>
        </div>

        <p class="stage-note">
          Droply detects the operating system, browser and coarse device type. Exact hardware models
          are not exposed by browsers, so a platform fallback is used instead of a guess.
        </p>
      </div>
    </section>
  `);

  const identitySlot = qs(element, "[data-identity]");
  const nameNode = qs(element, "[data-name]");
  const subtitleNode = qs(element, "[data-subtitle]");
  const typeNode = qs(element, "[data-device-type]");
  const platformNode = qs(element, "[data-platform]");
  const browserNode = qs(element, "[data-browser]");
  const fingerprintNode = qs(element, "[data-fingerprint]");
  const tagNode = qs(element, "[data-tag]");
  const actions = qs(element, "[data-actions]");
  const nameForm = qs(element, "[data-name-form]");
  const nameInput = qs(element, "[data-name-input]");
  const avatarPanel = qs(element, "[data-avatar-panel]");
  const avatarOptions = qs(element, "[data-avatar-options]");
  const resetConfirm = qs(element, "[data-reset-confirm]");
  const errorBox = qs(element, "[data-error]");
  const errorText = qs(element, "[data-error-text]");

  function showError(message) {
    errorText.textContent = String(message ?? "");
    errorBox.hidden = !message;
  }

  function closeEditors() {
    confirmingReset = false;
    nameForm.hidden = true;
    avatarPanel.hidden = true;
    resetConfirm.hidden = true;
  }

  function render() {
    if (!identity) return;
    identitySlot.dataset.fallback = "false";
    identitySlot.innerHTML = deviceAvatarMarkup(identity.avatar, {
      size: "xl",
      label: `${identity.name} avatar`,
    });
    nameNode.textContent = identity.name;
    subtitleNode.textContent = formatDeviceSubtitle(identity);
    typeNode.textContent = identity.deviceType || "—";
    platformNode.textContent = identity.platform || "—";
    browserNode.textContent = identity.browser || "—";
    fingerprintNode.textContent = formatFingerprint(identity.fingerprint);
    tagNode.textContent = identity.suffix || "—";
    fingerprintNode.title = `Device ID ${identity.deviceId}`;
    nameInput.value = identity.name;
    avatarOptions.innerHTML = avatarPickerMarkup(identity.avatar);
    actions.hidden = false;
  }

  async function apply(patch) {
    if (busy) return;
    busy = true;
    showError("");
    try {
      const updated = await onUpdate(patch);
      if (updated && typeof updated === "object") identity = updated;
      closeEditors();
      render();
    } catch (error) {
      showError(error?.message ?? "That change could not be saved.");
    } finally {
      busy = false;
    }
  }

  qs(element, "[data-back]").addEventListener("click", onBack);

  qs(element, "[data-edit-name]").addEventListener("click", () => {
    closeEditors();
    nameForm.hidden = false;
    nameInput.focus();
    nameInput.select();
  });

  qs(element, "[data-name-cancel]").addEventListener("click", () => {
    nameForm.hidden = true;
    nameInput.value = identity?.name ?? "";
  });

  nameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      showError("Choose a device name.");
      nameInput.focus();
      return;
    }
    if (name === identity?.name) {
      closeEditors();
      return;
    }
    void apply({ name });
  });

  qs(element, "[data-edit-avatar]").addEventListener("click", () => {
    closeEditors();
    avatarPanel.hidden = false;
  });

  qs(element, "[data-avatar-cancel]").addEventListener("click", () => {
    avatarPanel.hidden = true;
  });

  avatarOptions.addEventListener("click", (event) => {
    const choice = event.target.closest("[data-avatar-choice]");
    if (!choice) return;
    const avatar = choice.dataset.avatarChoice;
    if (avatar === identity?.avatar) {
      avatarPanel.hidden = true;
      return;
    }
    void apply({ avatar });
  });

  qs(element, "[data-regenerate]").addEventListener("click", () => {
    closeEditors();
    confirmingReset = true;
    resetConfirm.hidden = false;
  });

  qs(element, "[data-reset-cancel]").addEventListener("click", () => {
    confirmingReset = false;
    resetConfirm.hidden = true;
  });

  qs(element, "[data-reset-confirm-button]").addEventListener("click", () => {
    void apply({ regenerateSuffix: true });
  });

  actions.hidden = true;

  Promise.resolve(identityPromise)
    .then((value) => {
      identity = value;
      render();
    })
    .catch((error) => {
      nameNode.textContent = "Profile unavailable";
      subtitleNode.textContent = "This browser did not allow local storage.";
      showError(error?.message ?? "This browser did not allow Droply to store a device profile.");
    });

  return { element, title: "Device profile" };
}
