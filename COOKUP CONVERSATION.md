# Cookup - Project Conversation & Handoff

This document captures the full project context for Cookup, a Mac + Windows
desktop app that generates beats from a text prompt (plus optional reference
songs) using Meta's MusicGen running locally. Cory asked for this as a handoff
so another Claude session can pick up where we left off.

---

## What Cookup is

- **Vision:** Type a "recipe" (e.g. "dark trap, deep 808s, eerie piano"),
  optionally upload reference songs as "ingredients," hit Cook, and get a WAV
  you drag straight into Logic Pro / any DAW.
- **Positioning:** Started as a Logic Pro plugin idea; pivoted to a standalone
  desktop app because real AU plugins need Xcode + Apple's AU SDK. The
  drag-into-Logic flow still works; it's just a separate window next to the DAW.
- **Tone:** Stove / kitchen metaphor. Recipe = prompt. Ingredients = reference
  songs. Cook = Generate. Heat levels = Simmer / Sear / Flambe (map to
  temperature + CFG on MusicGen). Burner dial = BPM.

## Stack decisions

- **Electron** for cross-platform UI (Mac + Windows from the same code)
- **MusicGen-Melody running LOCALLY** via a Flask server in Python. No API,
  no monthly cost, no keys. Model lives on the user's computer.
- **electron-builder** for packaging: .dmg (Mac) and .exe installer (Windows NSIS)
- **python-build-standalone** provides portable Python bundled inside the app
- **GitHub Actions** for cloud builds (zero-Terminal for Cory)

## Why we're not training our own model

- Training to Suno-level quality = $1M-$10M + research team
- Smaller from-scratch = $10k-$100k + ML expertise
- Fine-tuning MusicGen = $50-$500 (realistic hobbyist path)
- Free option: run Meta's open-source MusicGen locally, label it "Cookup AI"

We went with the free option.

## Website plan (deferred)

Cory wants a website, but as a download page not the app itself. Two big
buttons: "Download for Mac" / "Download for Windows" pointing at GitHub
release artifacts. Cheap to host. Not started yet.

---

## File layout (as it exists in `Cook Up/`)

```
Cook Up/
  package.json                    Electron + electron-builder config
                                  (Mac DMG + Windows NSIS targets)
  main.js                         Electron main process
                                  - spawns Python server
                                  - cross-platform resolvePython()
                                  - IPC for file dialogs + drag-out
  preload.js                      contextBridge for renderer
  src/
    generator.js                  HTTP client to localhost MusicGen server
    musicgen_server.py            Flask server wrapping MusicGen-Melody.
                                  Endpoints: /health /warmup /generate
  renderer/
    index.html                    UI: recipe / ingredients / stove card /
                                  burner dial / heat buttons / Cook button
    styles.css                    Stove/kitchen dark theme, ~350 lines.
                                  Flames animate under Cook while generating.
                                  Burner glows when hot.
    renderer.js                   UI logic. Burner dial supports drag +
                                  scroll wheel for BPM (60-180).
  assets/
    drag-icon.png                 Cursor icon while dragging a beat out
  build/
    icon.png, icon.svg, icon-64   App icon (flame in pink->orange tile)
                                  electron-builder reads icon.png for .icns
  scripts/
    bundle-python.sh              Mac Python bundler
    bundle-python.ps1             Windows Python bundler (PowerShell)
  .github/
    workflows/
      build.yml                   GitHub Actions: build-mac (macos-14) +
                                  build-win (windows-latest). Each installs
                                  Node, bundles Python, runs electron-builder,
                                  uploads DMG/exe as artifact.
  setup.sh                        Dev-loop setup (creates .venv)
  Build Cookup.command            Mac double-click to build DMG locally
  README.md, READ ME FIRST.txt, GITHUB SETUP.txt, WINDOWS INSTALL.txt
  .gitignore
```

## Important technical details

### main.js: resolvePython()
Finds Python in priority order:
1. User override in settings (pythonPath)
2. Bundled python-runtime inside packaged app (process.resourcesPath)
3. Co-located python-runtime in dev
4. .venv
5. System python3/python.exe on PATH

Cross-platform: Windows looks for `python.exe` at the runtime root;
Mac/Linux looks for `bin/python3`.

### musicgen_server.py: heat levels
Kitchen UI to MusicGen sampling params:
- `simmer`: temp 0.8, cfg_coef 2.5, top_k 200 (calmer, reference-dominant)
- `sear`:   temp 1.0, cfg_coef 3.0, top_k 250 (default)
- `flambe`: temp 1.2, cfg_coef 4.5, top_k 350 (wilder)

### Reference song handling
MusicGen-Melody accepts one melody via `generate_with_chroma`. Multiple
ingredient songs -> first is used for melody conditioning; all names fold
into the prompt as style hints. Future improvement: mix multiple refs down
first.

### Cross-platform packaging gotchas
- Mac bundle: `cpython-*-aarch64-apple-darwin-install_only.tar.gz`
- Windows bundle: `cpython-*-x86_64-pc-windows-msvc-install_only.tar.gz`
- Windows uses CPU PyTorch for broad compat; WINDOWS INSTALL.txt documents
  switching to CUDA for NVIDIA GPUs
- audiocraft on Windows: xformers has no stable wheel -> bundle-python.ps1
  installs audiocraft with --no-deps, then deps manually
- No Apple Developer cert ($99/yr): unsigned -> Mac needs right-click -> Open
  on first launch. Windows SmartScreen needs "More info -> Run anyway" once.

### GitHub Actions workflow
`.github/workflows/build.yml` has two jobs:
- `build-mac` on macos-14 (Apple Silicon) -> `dist/*.dmg`
- `build-win` on windows-latest -> `dist/*.exe`
Artifacts named Cookup-Mac-dmg and Cookup-Windows-exe, kept 30 days.
Triggered on push to main or manual "Run workflow."

---

## Where we left off (current sticking point)

Cory is setting up GitHub Actions. They:
1. Made a GitHub account: `wackytownkids-commits`
2. Created repo: `Cook-Up` (https://github.com/wackytownkids-commits/Cook-Up)
3. Tried to upload the folder contents; the `.github` folder (hidden, leading
   dot) did not come along at first
4. Tried Option B: creating `build.yml` directly via GitHub's web editor
5. Claims the file is now at `.github/workflows/build.yml`
6. BUT: the Actions tab still shows the "Get started with GitHub Actions"
   template picker, meaning GitHub still doesn't see a valid workflow

Open diagnostic: need Cory to confirm via the Code tab:
- Does `.github/workflows/build.yml` actually exist?
- What's the first line of that file? (should be `name: Build Cookup`)
- What's the default branch name? (workflow listens for `main` push)

Common causes:
- File at repo root instead of inside `.github/workflows/`
- Default branch is `master` not `main`
- YAML syntax broken from copy-paste

## Next steps (once builds run)

1. First successful GitHub Actions run -> download Mac DMG + Windows EXE
2. Install both, test generating a beat
3. Build the marketing website (one-page, two download buttons, GitHub Pages)
4. Optional: add vocals model later (requires different model, reintroduces $)
5. Optional: fine-tune MusicGen on preferred style ($50-$500 one-time)
6. Optional: pay $99/yr for Apple Developer cert to remove first-launch prompt

## User profile notes

- Cory is a beatmaker / producer, not a developer
- Uses Logic Pro on Mac; also has a Windows PC
- Strongly prefers zero Terminal
- Casual, short messages. Asks clarifying questions when jargon trips them up
- Works best when we explain WHY, not just HOW
- Does not have an Apple Developer Program membership
- Wants to distribute publicly via a website eventually

## Conversation arc (high level)

1. Initial ask: "Logic Pro plugin that remixes a prompt with reference songs"
2. Clarified constraints: real AU plugins need Xcode; picked desktop app path
3. Built initial Electron skeleton targeting Suno API (BeatForge)
4. Renamed to Cookup
5. Designed flame app icon
6. Pivoted backend from Suno (paid/sketchy) to local MusicGen (free)
7. Redesigned UI for stove/kitchen vibe (burner dial for BPM, heat modes,
   animated flames, cook button)
8. Added one-click Mac install via `Build Cookup.command`
9. Added GitHub Actions so Cory never has to use Terminal
10. Added Windows build target + PowerShell Python bundler
11. Got stuck on GitHub Actions setup - workflow file placement issues
