# Contributing to Droply

Thanks for taking the time to contribute. Droply is a small, dependency-light project, so the bar is
mostly about keeping it real: no fake UI, no placeholder handlers, no unnecessary dependencies.

## Getting set up

```bash
git clone https://github.com/Alshahriar-07/Droply.git
cd Droply
cd worker && npm install && npm run dev     # signaling on :8787
# in another terminal, from the repo root:
npx serve . -l 3000                         # frontend on :3000
```

Open http://localhost:3000 in two browsers (or a normal and a private window) and complete a real
transfer before opening a pull request that touches the transfer path.

## Ground rules

- **Real behaviour only.** Every button must do something. Never ship placeholder dialogs, fake
  progress bars, or simulated connections.
- **No new frameworks or build tooling** for the frontend. It is plain HTML, CSS and ES modules on
  purpose. Vendor a small library into `js/vendor/` if you truly need one, with its licence.
- **Keep the halves separate.** Browser code lives in `js/`, server code in `worker/src/`. File data
  must never be sent to the Worker.
- **Honest status.** Do not show "Connected" before the data channel opens, or "Complete" before every
  byte has arrived.
- **Clean up.** Any new resource (timer, listener, socket, stream, object URL) belongs in a
  `ResourceScope` so cancellation and error paths release it.

## Style

- ES modules, `const`/`let`, two-space indent, double quotes, semicolons.
- Small focused modules; JSDoc on exported functions and on non-obvious WebRTC logic.
- CSS: use the tokens in `css/tokens.css`; no hard-coded colours or one-off spacing values. New
  component styles go in `css/components.css`, layout in `css/layout.css`.
- Accessibility is not optional: use semantic elements, label every control, keep a visible focus
  ring, and make sure status messages are announced (`role="status"` / `aria-live`).

## Automated checks

```bash
npm test                     # error catalog + mapping (node --test, no dependencies)
cd worker && npm run check   # Worker syntax check
```

If you add a new failure state, add it to `js/core/errors.js` and read
[docs/ERRORS.md](docs/ERRORS.md) first — the suite fails on missing copy, unknown icons and
unsupported action ids.

## Manual test before a PR

1. Send two files, one empty and one ≥ 100 MB, to a second browser.
2. Confirm the receiver sees the consent screen first and no bytes move before accepting.
3. Confirm progress, speed and ETA look plausible and finish at 100%.
4. Confirm the downloaded files are byte-identical (`sha256sum` / `certutil -hashfile`).
5. Cancel a transfer mid-flight, then reload both tabs — no console errors, no stuck state.
6. Re-use a completed room code — it must be rejected (completed rooms keep no state, so it reports
   "code not found").
7. Check the layout at 360 px, 390 px, 768 px, 1024 px and 1440 px.

Report what you actually ran, and say so when something was not tested.

## Commit messages

Short imperative subject, then a paragraph explaining *why* the change is needed. One logical change
per commit is preferred.

## Security

Do not report vulnerabilities in issues or pull requests — follow [SECURITY.md](SECURITY.md). Never
commit Cloudflare tokens, TURN credentials, or `.env` files; `.gitignore` already excludes them.

## Licence

By contributing you agree that your work is released under the [MIT License](LICENSE).
