# TouchDesigner Visualization Integration for Mentalist Mode

## Overview

Integrate TouchDesigner visualizations with Parlor's mentalist mode, enabling the AI to dynamically augment the participant with visual effects that reflect insights learned during the reading.

## Architecture

```
Parlor (Electron)                          TouchDesigner
├── OSC (localhost:9000) ──────────────────> Skeleton/face data (existing)
├── Spout ("Parlor", "Parlor Mask") ───────> Video/mask textures (existing)
└── WebSocket (localhost:8001) ────────────> Scene control commands (NEW)
         ↑
    Gemini Tools
```

**Key Decisions:**
- OSC continues for real-time skeleton data (30fps)
- Spout continues for video/mask (existing)
- WebSocket for scene control (event-driven, not streaming)
- Gemini tools control visuals (not MCP, since AI is Gemini)

---

## Phase 1: TD WebSocket Bridge

**Status:** Complete

**Goal:** Bidirectional WebSocket communication between Parlor and TouchDesigner.

### Files Created

| File | Purpose | Status |
|------|---------|--------|
| `src/main/td-bridge/types.ts` | TypeScript interfaces | Complete |
| `src/main/td-bridge/connection.ts` | WebSocket lifecycle | Complete |
| `src/main/td-bridge/protocol.ts` | Message parsing | Complete |
| `src/main/td-bridge/push.ts` | Outbound methods | Complete |
| `src/main/td-bridge/index.ts` | Main TDBridge class | Complete |

### Files Modified

| File | Changes | Status |
|------|---------|--------|
| `src/main/index.ts` | Initialize TDBridge, add IPC handlers | Complete |
| `src/preload/index.ts` | Expose tdBridge API to renderer | Complete |

### Protocol Messages

```typescript
// Parlor → TD
{ type: "scene_params", params: {...} }
{ type: "mood_update", mood: string, color?: string, intensity?: number }
{ type: "reveal_effect", effect_type: string, intensity: number, duration: number, landmark?: number }
{ type: "aura_update", color: string, size: number, behavior: string }
{ type: "skeleton_augment", overlays: [...] }
{ type: "ping" }

// TD → Parlor
{ type: "td_ready", capabilities: {...} }
{ type: "compile_result", zone: string, success: boolean, error?: string }
{ type: "metrics", fps: number, particle_count: number, coverage: number }
{ type: "pong" }
```

### Success Criteria
- [x] WebSocket server starts on port 8001
- [x] TD Bridge initializes correctly
- [x] Error callbacks working
- [ ] TD connects to Parlor WebSocket (needs TD script)
- [ ] `td_ready` message received and logged (needs TD script)
- [ ] Basic `mood_update` messages received by TD (needs TD script)

### Progress Notes

**2024-04-28:** Phase 1 implementation complete.
- Created full td-bridge module with types, connection, protocol, and push layers
- Integrated into main process with callbacks for connect/disconnect/ready/error
- Added IPC handlers: `td-get-status`, `td-push-mood`, `td-push-scene`, `td-push-reveal`
- Exposed `tdBridge` API to renderer via preload
- WebSocket server confirmed starting on port 8001
- Next: Create TD WebSocket client script to test full connectivity

---

## Phase 2: Gemini Tools for Scene Control

**Status:** Complete

**Goal:** Enable Gemini to manipulate TD visuals via function calling.

### New Tools (added to `src/main/mentalist/prompts.ts`)

```typescript
{
  name: 'set_visual_scene',
  parameters: {
    particle_intensity: 'subtle' | 'moderate' | 'intense' | 'overwhelming',
    particle_behavior: 'calm' | 'orbiting' | 'attracted' | 'repelled' | 'burst' | 'trailing',
    particle_color: string,
    aura_color: string,
    aura_size: number,
    background_mood: 'mysterious' | 'warm' | 'cold' | 'electric' | 'transcendent'
  }
},
{
  name: 'trigger_visual_reveal',
  parameters: {
    effect_type: 'burst' | 'converge' | 'ripple' | 'ascend' | 'transform',
    color: string,
    intensity: number,
    duration: number,
    center_landmark?: number
  }
},
{
  name: 'set_skeleton_overlay',
  parameters: {
    overlays: Array<{
      landmark_start: number,
      landmark_end: number,
      effect: 'glow' | 'trail' | 'geometric' | 'energy_line',
      color: string,
      intensity: number
    }>
  }
}
```

### Files Modified

| File | Changes | Status |
|------|---------|--------|
| `src/main/mentalist/prompts.ts` | Add visual tool definitions + system prompt guidance | Complete |
| `src/main/mentalist/session.ts` | Add tool handlers calling TDBridge | Complete |
| `src/main/mentalist/types.ts` | Add visual parameter types | Complete |

### Success Criteria
- [x] Gemini can call `set_visual_scene` during reading
- [x] Gemini can call `trigger_visual_reveal` for dramatic moments
- [x] Gemini can call `set_skeleton_overlay` to highlight body parts
- [x] Existing `set_mood` also pushes to TD when connected
- [x] Tool failures (TD not connected) handled gracefully
- [ ] TD receives and applies visual changes (needs TD-side implementation)
- [ ] Effects sync with mentalist speech/reveals (needs TD-side implementation)

### Progress Notes

**2024-04-28:** Phase 2 implementation complete.
- Added `SetVisualSceneParams`, `TriggerVisualRevealParams`, `SetSkeletonOverlayParams` types
- Updated `MentalistToolCall` union to include new tool names
- Added 3 tool definitions to `MENTALIST_TOOLS` array with full Gemini function calling schema
- Updated system prompt with Visual Tool Usage guidance and MediaPipe landmark reference
- Added handlers in `handleToolCalls()` for all 3 new tools
- Wired existing `set_mood` tool to also push to TD via `pushMoodUpdate()`
- All tools check `isTDConnected()` and return graceful error if TD not available
- Build succeeds with no TypeScript errors
- Next: Phase 3 requires TouchDesigner project setup to receive and render these messages

---

## Phase 3: TD WebSocket Client & Scene Control

**Status:** Complete

**Goal:** TD receives WebSocket messages from Parlor and applies visual changes.

### TD Network Created

```
ws_parlor (websocketDAT) ──> ws_callbacks (textDAT)
                                    │
                              scene_state (tableDAT)
                                    │
              ┌─────────────────────┴─────────────────────┐
              ▼                                           ▼
    aura_base (circleTOP)                     skeleton_draw_callbacks
         │                                    (overlay support added)
    aura_blur (blurTOP)
         │
    aura_tint (constantTOP) ◄── expressions read scene_state
         │
    aura_multiply (multiplyTOP)
         │
    aura_composite (compositeTOP, screen blend)
         │
    comp_output (skeleton over aura+video)
```

### Files Created

| File | Purpose | Status |
|------|---------|--------|
| `td/scripts/ws_callbacks.py` | WebSocket message handlers (external reference) | Complete |
| `/project1/ws_callbacks` (textDAT) | Inline callbacks in TD | Complete |
| `/project1/scene_state` (tableDAT) | Store current scene parameters | Complete |
| `/project1/aura_*` (TOPs) | Aura glow effect chain | Complete |
| `/project1/skeleton_draw_callbacks` | Updated with overlay support | Complete |

### Success Criteria
- [x] WebSocket connects to Parlor on port 8001
- [x] TD sends `td_ready` message with capabilities
- [x] `mood_update` changes aura color via scene_state
- [x] `scene_params` updates particle/aura settings
- [x] `skeleton_augment` draws overlay lines on skeleton
- [x] Ping/pong heartbeat works
- [x] Aura color dynamically reads from scene_state hex values

### Progress Notes

**2024-04-28:** Phase 3 complete.
- Created websocketDAT connecting to ws://127.0.0.1:8001
- Inline callbacks handle all message types (mood_update, scene_params, reveal_effect, aura_update, skeleton_augment)
- Scene state stored in tableDAT with key/value pairs
- Aura effect chain uses Python expressions to read hex colors from scene_state and convert to RGB
- Skeleton draw callbacks match Parlor colors (green lines, red points) with Gemini overlay support
- Aura composited using screen blend mode for glow effect
- Fixed Spout coordinate alignment via CSS (`body.spout-mode` fills 100vw×100vh) + Y-flip in TD

---

## Phase 4: Insight-Driven Augmentation

**Status:** Not Started

**Goal:** Visuals that evolve based on accumulated insights.

### Phase-Specific Visuals

| Phase | Visual Treatment |
|-------|------------------|
| `intro` | Subtle ambient particles, gentle aura scan |
| `reading` | Growing particle density, aura responds to tension |
| `reveal` | Burst effects, skeleton highlights, dramatic colors |
| `finale` | Full augmentation, integrated aura, peaceful settling |

### Insight → Visual Mapping

Each revealed insight adds a visual layer that stacks/blends:
- **emotion**: Aura color shift, pulsing rate
- **trait**: Particle motif change
- **prediction**: Energy lines between landmarks
- **secret**: Deep color saturation, intensity boost

### Files to Create

| File | Purpose | Status |
|------|---------|--------|
| `src/main/td-bridge/insight-visuals.ts` | Map insights to configs | Not Started |
| `src/main/td-bridge/phase-transitions.ts` | Phase transition visuals | Not Started |

### Success Criteria
- [ ] Each insight reveal triggers visual effect
- [ ] Visual complexity grows through reading
- [ ] Finale creates "complete portrait" of participant

### Progress Notes

_No progress yet._

---

## Phase 5: Integration & Polish

**Status:** Not Started

### Tasks
- [ ] TD disconnection recovery
- [ ] GLSL compilation error handling
- [ ] Graceful degradation if TD unavailable
- [ ] Performance monitoring (FPS, particle throttling)
- [ ] TD connection status in Parlor UI
- [ ] Configuration in settings (port, intensity prefs)
- [ ] Documentation

### Files to Create

| File | Purpose | Status |
|------|---------|--------|
| `docs/touchdesigner-setup.md` | TD project setup guide | Not Started |
| `src/main/td-bridge/health.ts` | Connection monitoring | Not Started |

### Progress Notes

_No progress yet._

---

## Dependencies

```
Phase 1 (TDBridge) ──────────────────────┐
                                          │
Phase 2 (Gemini Tools) ──────────────────┤
    depends on: Phase 1                   │
                                          ├──> Phase 5 (Integration)
Phase 3 (Skeleton Particles) ────────────┤
    depends on: Phase 1 + TD project      │
                                          │
Phase 4 (Insight Augmentation) ──────────┘
    depends on: Phase 2 + Phase 3
```

---

## Reference Files

| File | Purpose |
|------|---------|
| `src/main/mentalist/session.ts` | Tool handlers, visual callbacks |
| `src/main/mentalist/prompts.ts` | Gemini tool definitions |
| `src/main/index.ts` | TDBridge initialization |
| `vibe-agent/server/td_bridge/push.py` | Reference for WebSocket push |
| `vibe-agent/server/shader_tools.py` | Reference for tool schemas |

---

## Findings & Learnings

### OSC Coordinate Alignment (Phase 3)

**Problem:** Skeleton overlay in TD didn't align with Spout video - nose appeared at chin position.

**Root Cause:** Two issues:
1. CSS constraints (`max-width: 100%`, `max-height: 100vh`) in the offscreen Spout window caused the canvas to scale down
2. Y-axis coordinate system difference (web uses top-left origin, TD uses bottom-left)

**Solution:**
1. **CSS fix** in `index.html`: Added `body.spout-mode` styles that force canvas to fill 100vw × 100vh
2. **JS fix** in `main.ts`: Added `spout-mode` class to body when in Spout/Mask mode
3. **Y-flip** in TD: Apply `1 - y_norm` when converting OSC coordinates

```css
/* index.html - Spout mode fills entire window */
body.spout-mode #canvas {
  width: 100vw !important;
  height: 100vh !important;
  max-width: none !important;
  max-height: none !important;
}
```

```python
# skeleton_draw_callbacks - Direct 1:1 mapping with Y-flip
x = int(x_norm * width)
y = int((1 - y_norm) * height)  # Y-flip for OpenGL coords
```

### TD Node Recreation (Phase 3)

When TD crashes or is restarted, all dynamically created nodes are lost. The following nodes must be recreated:
- `ws_parlor` (websocketDAT) - connects to Parlor on port 8001
- `ws_callbacks` (textDAT) - inline Python callbacks
- `scene_state` (tableDAT) - key/value storage for scene parameters
- Aura effect chain: `aura_base`, `aura_blur`, `aura_tint`, `aura_multiply`, `aura_composite`

### Avoid numpy.flipud() in scriptTOP

Using `np.flipud(result)` before `copyNumpyArray()` caused TD to freeze/crash. Instead, flip coordinates during calculation or use a flipTOP downstream.
