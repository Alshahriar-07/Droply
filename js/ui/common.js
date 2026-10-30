/** Small DOM helpers shared by the views. */

import { hydrateIcons } from "./icons.js";
import { formatBytes } from "../utils/format-bytes.js";

/** Escapes text for safe interpolation into an HTML template string. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Creates an element from an HTML string and hydrates its icons.
 * @param {string} html
 * @returns {HTMLElement}
 */
export function el(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  const node = /** @type {HTMLElement} */ (template.content.firstElementChild);
  hydrateIcons(node);
  return node;
}

/** @param {Element|Document} root */
export function iconsIn(root) {
  hydrateIcons(root);
}

export function qs(root, selector) {
  return /** @type {HTMLElement|null} */ (root.querySelector(selector));
}

export function qsa(root, selector) {
  return Array.from(root.querySelectorAll(selector));
}

/** Adds an event listener and returns an unsubscribe function. */
export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/* --------------------------------------------------------------------------
   File presentation
   -------------------------------------------------------------------------- */

/**
 * Coarse category used for the file icon tile.
 * @param {{ name?: string, type?: string }} file
 */
export function fileKind(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (/zip|x-rar|x-7z|gzip|tar|compressed/.test(type) || /\.(zip|rar|7z|gz|tar|tgz)$/.test(name)) {
    return "archive";
  }
  if (
    type.startsWith("text/") ||
    /pdf|json|xml|csv|word|excel|presentation|msword|officedocument|rtf|epub/.test(type) ||
    /\.(txt|md|pdf|docx?|xlsx?|pptx?|csv|json|rtf|epub)$/.test(name)
  ) {
    return "document";
  }
  return "file";
}

const KIND_ICONS = {
  image: "image",
  video: "file-video",
  audio: "file-audio",
  archive: "file-archive",
  document: "file-text",
  file: "file",
};

export function fileIcon(kind) {
  return KIND_ICONS[kind] ?? "file";
}

/** Short human label for a file type, e.g. "PNG image" or "Document". */
export function fileTypeLabel(file) {
  const name = file.name || "";
  const extension = name.includes(".") ? name.split(".").pop().toUpperCase().slice(0, 5) : "";
  const kind = fileKind(file);
  const kindLabel = {
    image: "Image",
    video: "Video",
    audio: "Audio",
    archive: "Archive",
    document: "Document",
    file: "File",
  }[kind];
  return extension && extension !== name.toUpperCase() ? `${kindLabel} · ${extension}` : kindLabel;
}

/** Row markup for a selected or received file (name is escaped). */
export function fileRowMarkup(file, options = {}) {
  const kind = fileKind(file);
  const name = escapeHtml(file.name);
  const action = options.action ?? "";
  return `
    <li class="file-row" data-file-id="${escapeHtml(options.id ?? "")}">
      <span class="file-row__icon" data-kind="${kind}">
        <i data-icon="${fileIcon(kind)}" data-size="18"></i>
      </span>
      <span class="file-row__body">
        <span class="file-row__name" title="${name}">${name}</span>
        <span class="file-row__meta">
          <span>${escapeHtml(fileTypeLabel(file))}</span>
          <span class="file-row__meta-sep"></span>
          <span>${formatBytes(file.size)}</span>
        </span>
      </span>
      ${action ? `<span class="file-row__action">${action}</span>` : ""}
    </li>`;
}

/* --------------------------------------------------------------------------
   Toasts
   -------------------------------------------------------------------------- */

let toastTimer = 0;

/**
 * Short non-blocking feedback. Also announced to screen readers because the
 * toast stack is a live region.
 * @param {string} message
 * @param {{ tone?: "default"|"success"|"danger", duration?: number }} [options]
 */
export function toast(message, options = {}) {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const tone = options.tone ?? "default";
  const node = document.createElement("div");
  node.className = `toast${tone === "default" ? "" : ` toast--${tone}`}`;
  node.textContent = message;
  stack.replaceChildren(node);

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.dataset.leaving = "true";
    window.setTimeout(() => node.remove(), 220);
  }, options.duration ?? 3600);
}

/* --------------------------------------------------------------------------
   Clipboard
   -------------------------------------------------------------------------- */

/** Copies text, with a fallback for browsers without the async clipboard. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------------
   Misc
   -------------------------------------------------------------------------- */

/** Sets a CSS custom property used by the progress bar fill. */
export function setProgress(element, ratio) {
  if (!element) return;
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  element.style.setProperty("--progress", String(clamped));
}

/** Triggers a browser download for an object URL. */
export function downloadUrl(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Opens one of the informational <dialog> sheets. */
export function openDialog(id) {
  const dialog = document.getElementById(`dialog-${id}`);
  if (dialog instanceof HTMLDialogElement) dialog.showModal();
}

/** Wires the footer "how it works" / "privacy" sheets. */
export function bindInfoDialogs() {
  document.addEventListener("click", (event) => {
    const opener = event.target.closest("[data-open-dialog]");
    if (opener) {
      openDialog(opener.dataset.openDialog);
      return;
    }
    const closer = event.target.closest("[data-close-dialog]");
    if (closer) {
      closer.closest("dialog")?.close();
    }
  });
}
