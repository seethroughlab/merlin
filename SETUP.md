# Setup Guide

Detailed setup walkthrough for a fresh development machine. The short version is in [`README.md`](./README.md); this file covers what to install, what to configure, and what to do when something doesn't work.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 18 LTS or later | Tested on 20 and 22 |
| **npm** | 9+ | Bundled with Node |
| **TouchDesigner** | 2024.11000 or later | Free non-commercial license works. Older 2023.x may compile shaders OK but the POP system and `glslPOP` API used here is 2024+. |
| **OS** | Windows 11 | macOS/Linux Electron build is untested. TouchDesigner is Windows + macOS only. |
| **GPU** | DX11/Vulkan capable | Any modern discrete or recent integrated (Intel Iris Xe, AMD Vega, NVIDIA GTX 16xx+). GLSL compiles on the GPU. |
| **Webcam** | USB or built-in, 1280×720+ | MediaPipe pose + face. Internal laptop cameras work but exposure can be quirky in low light. |
| **Gemini API key** | Free tier OK for dev | https://aistudio.google.com/apikey |
| **Anthropic API key** | Optional | Enables Claude-as-participant in the Conversation Tester |

### Optional: Syphon / Spout output

If you want to send the final composite to another app (e.g. for projection mapping), enable Spout:

```bash
npm run dev:spout
```

The renderer's BrowserWindow gets a `--spout` flag; the Spout sender publishes a texture named `Merlin Mask` (used by TD's `spout_mask` IN for body-occlusion). No additional install needed on Windows — Spout's native binding is bundled via `@napolab/texture-bridge-core`.

## First-run walkthrough

1. **Clone and install**
   ```bash
   git clone <repo>
   cd Merlin
   npm install
   ```
   Initial install takes ~3 minutes (Electron + MediaPipe wasm + Transformers.js Whisper model).

2. **Environment**
   ```bash
   cp .env.example .env
   ```
   Fill in `GEMINI_API_KEY`. Optionally add `ANTHROPIC_API_KEY` and `MERLIN_LOG_LEVEL=debug` (default `info`).

3. **Launch TouchDesigner first**
   - Open `td/demo.toe` in TouchDesigner.
   - You'll see a render of the webcam and the particle system idle. TD is waiting for a WebSocket client.

4. **Launch Electron**
   ```bash
   npm run dev
   ```
   The `predev` script (`scripts/kill-stale-merlin.cjs`) reaps any process holding port 8001 first. TD reconnects within ~1s and emits `td_ready` — you'll see it in both consoles.

5. **Sanity check**
   - In the Electron window: **Shift+T** opens the test panel.
   - Pick the **Shaders** tab → "Generate (all 8 zones)". You should see Gemini fill zones in ~10–20 seconds.
   - Pick the **Live Spell** tab → preset "drifting sparks". You should see a sprite generated, zones filled, and a screenshot evaluation back-and-forth.

6. **Live session**
   - **Shift+M** starts a Merlin session (intro narration via TTS, then continuous listening).
   - Speak — Merlin responds and pushes spell visuals to TD.
   - Speak the magic word Merlin gave you → cast fires. Merlin says a short welcome line, then goes silent.
   - The session closes on its own after 60 seconds of inactivity (re-speaking the magic word during play resets the timer).

## Troubleshooting

**"TD not connected" / particles aren't moving**
The Electron app shows TD status in the sidebar. Common causes:
- TD isn't running — open `td/demo.toe`.
- Port 8001 is held by a stale process. `predev` should kill it; if not, find and kill it manually (Task Manager → Electron / node).
- TD's `/project1/ws_merlin_callbacks` textDAT lost its file binding. Open the .toe, select the DAT, verify `file` points at `scripts/ws_callbacks.py` and `syncfile=1`.

**Shaders don't compile**
- Open TD's textport. Failed compiles print to it from `_check_glsl_compile`.
- The bridge auto-rolls-back to the previous good code (or the template) — you should see `Zone 'X' compiled` or a rollback log in the Electron console.

**Sprite-load timeouts**
The default is 8s (configurable in `src/main/config.ts:TIMEOUTS.TD_SPRITE_LOAD_MS`). On slow disks, bump it.

**`predev` kills my session every time**
Disable by setting `MERLIN_SKIP_KILL=1` in your shell. The script will warn and skip the reap step.

**Webcam isn't detected**
MediaPipe uses the renderer's `getUserMedia`. Open DevTools (Ctrl+Shift+I) → Console; you should see device-list output at startup. Permission prompts only fire once per machine. If you see "Permission denied", clear it in Windows Settings → Privacy → Camera.

**Audio / TTS not playing**
The renderer uses a LiveTTS WebSocket to Gemini's TTS endpoint. If the connection fails, console logs `[LiveTTS]`. Common cause: corporate firewall blocks the Gemini TTS endpoint. There's no offline fallback yet.

**MCP-created TD nodes vanish after restart**
TouchDesigner doesn't auto-save. If you (or an MCP automation) creates nodes in TD via the MCP server, **save `td/demo.toe` immediately** or those nodes are lost on the next TD restart. The WS callbacks self-heal expression-bound uniforms, but they can't recreate the nodes themselves.

## Logging

- Main-process logs go to the Electron-launched terminal.
- Renderer logs go to DevTools console (Ctrl+Shift+I).
- TD-side logs go to TD's textport (Alt+T).
- Filter main-process verbosity with `MERLIN_LOG_LEVEL=debug|info|warn|error`.

## What `npm run dev` actually does

1. `predev`: `node scripts/kill-stale-merlin.cjs` — reap anything on port 8001 (Windows-friendly `netstat`/`taskkill` path).
2. `vite`: starts Vite in Electron mode. The main process boots, initializes Gemini, opens the WS server on 8001, and waits for TD.

If you'd rather not auto-kill the port, run `vite` directly: `npx vite`.
