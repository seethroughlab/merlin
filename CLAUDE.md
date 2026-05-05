# Merlin Mirror

Interactive AR experience combining Electron, MediaPipe tracking, and TouchDesigner visuals.

## Architecture

- **Electron App** (`src/main/`, `src/renderer/`): Camera capture, AI chat, spell recognition
- **TouchDesigner** (`td/demo.toe`): Real-time particle systems, shaders, compositing
- **Bridge**: WebSocket on port 9980 for Electron↔TD communication

## Key Modules

### src/main/merlin/
- `session.ts` - Merlin session orchestration
- `spell-state.ts` - Spell detection state machine
- `asset-manager.ts` - Sprite/flipbook asset storage (97% tested)
- `sprite-generator.ts` - Gemini-powered sprite generation
- `glsl-validator.ts` - GLSL zone code validation (99% tested)
- `zone-registry.ts` - Zone contract definitions (93% tested)
- `zone-state.ts` - Zone compilation state tracking

### src/main/td-bridge/
- `connection.ts` - WebSocket client to TD
- `push.ts` - Outbound messages to TD (91% tested)
- `metrics.ts` - Performance metrics (100% tested)

### shaders/
- `mat_billboard_vertex.glsl` - Billboard particle vertex shader
- `mat_billboard_pixel.glsl` - Flipbook animation + color modulation
- Templates in `glsl_templates/` for POP system

## Commands

```bash
npm run dev          # Start Electron dev server
npm test             # Run Vitest tests (249 tests)
npm run dist         # Build distribution
```

## Testing Patterns

- Use `vi.hoisted()` for mock factories
- Use `vi.resetModules()` + dynamic imports for module-level state
- Mock fs, electron.app, crypto for asset tests
- Mock connection module for push tests

## TouchDesigner Integration

TD connects via WebSocket. Message types:
- `zone_update` - GLSL zone code injection
- `sprite_texture` - Load sprite PNG
- `flipbook_config` - Atlas grid/playback settings
- `tracking_frame` - MediaPipe pose/face data

## Recent Work (May 2025)

- Implemented sprite generation system with Gemini Imagen
- Billboard particle rendering with flipbook animation
- Test coverage: 249 tests, key modules at 90%+ coverage
- Starting particle systems integration
