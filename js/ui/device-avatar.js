/** Consistent device avatar + identity markup used by every screen. */

import { AVATARS, formatDeviceSubtitle, sanitizeAvatarId } from "../core/device-profile.js";
import { escapeHtml } from "./common.js";
import { icon } from "./icons.js";

const ICON_SIZE = { xs: 14, sm: 16, md: 19, lg: 30, xl: 42 };

export function avatarDefinition(avatarId) {
  const id = sanitizeAvatarId(avatarId);
  return AVATARS.find((avatar) => avatar.id === id) ?? AVATARS.at(-1);
}

/**
 * @param {string} avatarId
 * @param {{ size?: "xs"|"sm"|"md"|"lg"|"xl", className?: string, label?: string }} [options]
 */
export function deviceAvatarMarkup(avatarId, options = {}) {
  const definition = avatarDefinition(avatarId);
  const size = options.size ?? "md";
  const accessibility = options.label
    ? ` role="img" aria-label="${escapeHtml(options.label)}"`
    : ` aria-hidden="true"`;
  return (
    `<span class="device-avatar device-avatar--${definition.id} device-avatar--${size}` +
    `${options.className ? ` ${options.className}` : ""}" data-tone="${definition.tone}"${accessibility}>` +
    `${icon(definition.icon, { size: ICON_SIZE[size] ?? ICON_SIZE.md })}` +
    `</span>`
  );
}

/**
 * Avatar + name + optional "Mobile · Android · Chrome" subtitle.
 * @param {{ name?: string, avatar?: string, deviceType?: string, platform?: string, browser?: string } | null} identity
 * @param {{
 *   size?: "xs"|"sm"|"md"|"lg"|"xl",
 *   detail?: boolean,
 *   className?: string,
 *   label?: string,
 *   fallback?: string
 * }} [options]
 */
export function identityMarkup(identity, options = {}) {
  const name = String(identity?.name ?? "").trim() || options.fallback || "Droply device";
  const subtitle = options.detail === false ? "" : formatDeviceSubtitle(identity ?? {});
  return `
    <span class="device-identity${options.className ? ` ${options.className}` : ""}">
      ${deviceAvatarMarkup(identity?.avatar, { size: options.size ?? "sm" })}
      <span class="device-identity__body">
        <span class="device-identity__name">${escapeHtml(name)}</span>
        ${subtitle ? `<span class="device-identity__meta">${escapeHtml(subtitle)}</span>` : ""}
      </span>
    </span>`;
}

/** Selectable avatar grid for the profile screen. */
export function avatarPickerMarkup(selected) {
  const active = sanitizeAvatarId(selected);
  return `
    <div class="avatar-picker" role="group" aria-label="Choose a device avatar">
      ${AVATARS.map(
        (avatar) => `
        <button type="button" class="avatar-option" data-avatar-choice="${avatar.id}"
          aria-pressed="${String(avatar.id === active)}" aria-label="${escapeHtml(avatar.label)}">
          ${deviceAvatarMarkup(avatar.id, { size: "md" })}
          <span>${escapeHtml(avatar.label)}</span>
        </button>`,
      ).join("")}
    </div>`;
}
