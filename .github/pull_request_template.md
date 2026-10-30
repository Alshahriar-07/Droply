## What this changes

<!-- One or two sentences. Focus on the reason for the change. -->

## Why

<!-- The problem or issue this addresses. Link it: Closes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] UI / UX improvement
- [ ] Documentation
- [ ] Refactor (no behaviour change)

## Testing

<!-- Say exactly what you ran. "Not tested" is an acceptable answer if it is true. -->

- [ ] Transfer completed between two browsers (files verified byte-identical)
- [ ] Receiver consent still blocks all file data until accepted
- [ ] Cancellation and error paths leave no console errors
- [ ] Completed room code is rejected
- [ ] Checked at 360 px, 768 px and 1440 px

## Checklist

- [ ] No placeholder buttons, fake progress or simulated connections
- [ ] File data still travels only over the WebRTC data channel
- [ ] New resources are added to a `ResourceScope` for cleanup
- [ ] No secrets, tokens or `.env` files included
- [ ] Documentation updated where relevant
