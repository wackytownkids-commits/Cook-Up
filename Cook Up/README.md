# Cookup

A Mac app that turns a prompt (plus optional reference songs) into an AI-generated
beat you drag straight into Logic Pro. Runs entirely on your Mac - no API key,
no cloud, no monthly bill. The model (Meta's MusicGen-Melody) is bundled inside
the app.

## For someone who just wants to use it

1. Download `Cookup.dmg`.
2. Open it. Drag Cookup to Applications.
3. First launch: right-click Cookup.app -> Open -> Open. (macOS asks once because
   the app isn't signed by an Apple developer account. After the first Open it
   launches normally forever.)
4. Wait ~30s on first Cook while MusicGen loads into RAM.
5. Type a recipe, hit Cook, drag the plate into Logic.

That's it. No Python, no Node, no Terminal.

## For Cory (how to build the DMG)

You need a Mac to build a Mac app (Apple's tooling is Mac-only).

```bash
cd "Logic Plugin"
npm install         # first time only
npm run dist:mac    # bundles Python, installs audiocraft, builds the DMG
```

Outputs:
- `dist/Cookup-0.1.0-arm64.dmg` for Apple Silicon Macs
- `dist/Cookup-0.1.0.dmg`      for Intel Macs

The build step runs `scripts/bundle-python.sh` automatically, which downloads
a portable Python and installs audiocraft/torch/flask into `python-runtime/`.
That folder gets embedded inside Cookup.app. The first build takes 15-20 minutes
(it's downloading and installing audiocraft). Subsequent builds are fast because
`python-runtime/` is cached.

## What's in the repo

```
Cookup/
  package.json                Electron + electron-builder config
  main.js                     Electron main (window, IPC, spawns Python server)
  preload.js                  Secure renderer bridge
  src/
    generator.js              Node client for the local MusicGen server
    musicgen_server.py        Flask server wrapping MusicGen-Melody
  renderer/
    index.html                UI (recipe + ingredients + burner + flames)
    styles.css                Kitchen-warm dark theme
    renderer.js               UI logic (burner knob, heat buttons, drag-out)
  assets/
    drag-icon.png             Cursor icon while dragging a beat out
  build/
    icon.png, icon.svg        App icon (electron-builder picks up icon.png)
  scripts/
    bundle-python.sh          Downloads portable Python + installs deps
  python-runtime/             (created by the bundle script; bundled into DMG)
```

## Running from source (Cory's dev loop)

If you want to run Cookup without building the DMG every time:

```bash
bash scripts/bundle-python.sh   # one-time; creates python-runtime/
npm install
npm start
```

Cookup launches and uses `python-runtime/bin/python3` automatically.

## Code signing and notarization (when you have $99 for an Apple developer account)

Once you get an Apple Developer Program membership, add to `package.json` under
`build.mac`:

```json
"identity": "Developer ID Application: Your Name (TEAMID)",
"hardenedRuntime": true,
"gatekeeperAssess": false,
"notarize": { "teamId": "TEAMID" }
```

Set the `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` env vars
and run `npm run dist:mac` again. The DMG comes out signed and notarized - users
no longer see the right-click-to-open prompt.

## Swapping MusicGen for something else

`src/musicgen_server.py` is intentionally small - one class, three endpoints.
Replace the body of `/generate` to swap in Stable Audio, Riffusion, a fine-tuned
model, or a remote API. The Electron side doesn't need to change.

## Known caveats

- **First Cook is slow.** 20-60s to load the model into RAM, then generation
  takes another 10-40s on Apple Silicon. Subsequent Cooks are fast.
- **One reference song at a time.** MusicGen-Melody only accepts one melody
  input; if you add several ingredients, the first one is used for conditioning.
- **Instrumental only.** MusicGen doesn't do vocals. If you want vocals,
  we'd need a different model and that reintroduces cost.
- **Not a real Audio Unit.** Cookup is a separate window next to Logic. A true
  AU plugin that lives inside Logic's plugin browser requires Xcode and Apple's
  AU SDK - happy to scaffold that separately.
