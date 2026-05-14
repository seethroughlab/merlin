# Merlin Mirror

Interactive AR spell-casting experience combining Electron (camera capture, MediaPipe pose + face landmarks, Gemini chat) and TouchDesigner (particles, GLSL shaders, compositing). A participant stands in front of a mirror display, talks to Merlin, and Gemini collaboratively writes the visual effect they cast — sprite generation, particle shaders, and a body-tracked render — in real time.

## Quick start

```bash
npm install
cp .env.example .env        # fill in GEMINI_API_KEY
npm run dev                 # starts Electron; predev reaps stale port 8001
```

Then open `td/demo.toe` in TouchDesigner (2024.11+). When TD connects to the WebSocket server on port 8001 you'll see `td_ready` in the console.

Trigger a live session with **Shift+M**, or open the test panel with **Shift+T**.

## Docs

| File | Purpose |
|------|---------|
| [`SETUP.md`](./SETUP.md) | Detailed prerequisites, first-run troubleshooting, API keys, Syphon/Spout setup |
| [`docs/HANDOFF.md`](./docs/HANDOFF.md) | Onboarding for new contributors — reading order, "where to start" file map, known issues |
| [`docs/architecture.md`](./docs/architecture.md) | System block diagram, data flows, error paths |
| [`docs/conversation-flow.md`](./docs/conversation-flow.md) | Per-turn execution: phase machine, IPC/WS events, listening lifecycle |
| [`docs/PRD.md`](./docs/PRD.md) | Design intent and intended participant experience |
| [`CLAUDE.md`](./CLAUDE.md) | Module-by-module architecture reference (used by Claude Code; safe for humans too) |
| [`td/ARCHITECTURE.md`](./td/ARCHITECTURE.md) | TouchDesigner-side: COMP layout, GLSL zones, body-tracking flow |

## Stack

- **Electron** + **Vite** + **TypeScript** (strict) — main process orchestrates Gemini, MediaPipe, IPC, WS
- **`@google/genai` v1+** for Gemini 3 Flash (chat + multimodal function responses + Imagen for sprites)
- **TouchDesigner 2024.11+** for the particle render and final composite
- **MediaPipe** Pose + FaceLandmarker in the renderer
- **WebSocket** on `localhost:8001` between Electron (server) and TD (client)

## Commands

```bash
npm run dev          # Electron dev (vite). predev reaps stale 8001.
npm run dev:spout    # Same, with Spout texture sender enabled
npm test             # Vitest run (414+ tests)
npm run test:watch   # Vitest watch
npm run lint         # ESLint on src/
npm run build        # tsc + vite build
npm run dist         # Build a Windows distribution
```

## License

Private. © See-Through Lab.
