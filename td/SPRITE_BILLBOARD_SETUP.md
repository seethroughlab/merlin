# Sprite & Billboard System Setup

This document describes the TouchDesigner node setup required for the sprite/billboard particle rendering system.

## Overview

The sprite system supports two rendering modes:
1. **Mesh mode** - Standard 3D mesh rendering (existing particle system)
2. **Billboard mode** - Camera-facing 2D sprites with flipbook animation

## Required TD Nodes

### 1. Sprite Texture TOP

**Path:** `/project1/sprite_texture`
**Type:** `fileTOP`

This TOP loads the sprite texture from disk. The texture path is set dynamically via WebSocket.

**Parameters:**
- `file`: Set dynamically via `sprite_texture` message
- Filter: Linear (for smooth scaling)
- Extend mode: Zero (black borders)

### 2. Sprite State Table

**Path:** `/project1/sprite_state`
**Type:** `tableDAT`

Stores sprite and flipbook configuration for easy access from shaders and scripts.

**Columns:** `key`, `value`

**Rows:**
| Key | Description | Example |
|-----|-------------|---------|
| `asset_id` | Current sprite asset UUID | `abc-123-def` |
| `texture_path` | Full path to texture file | `C:/Users/.../sprite.png` |
| `render_mode` | Rendering mode | `mesh` or `billboard` |
| `render_mode_float` | Mode as float for shaders | `0.0` or `1.0` |
| `atlas_cols` | Flipbook atlas columns | `4` |
| `atlas_rows` | Flipbook atlas rows | `4` |
| `frame_count` | Total animation frames | `16` |
| `playback_mode` | Animation playback style | `loop`, `once`, `pingpong`, `random` |
| `playback_mode_float` | Playback as float | `0.0` (loop) to `3.0` (random) |
| `frame_duration` | Seconds per frame | `0.1` |
| `drive_source` | What drives frame selection | `age`, `life`, `velocity`, `id`, `time` |
| `drive_source_float` | Drive source as float | `0.0` (age) to `4.0` (time) |

### 3. Billboard Material

**Path:** `/project1/billboard_mat`
**Type:** `glslMAT`

GLSL material for rendering camera-facing billboard sprites.

**Shader DATs:**
- Vertex: `/project1/billboard_mat_vertex` (contains `mat_billboard_vertex.glsl`)
- Pixel: `/project1/billboard_mat_pixel` (contains `mat_billboard_pixel.glsl`)

**Uniforms (vec4):**
| Uniform | Components | Description |
|---------|------------|-------------|
| `uFlipbook1` | `(cols, rows, frameCount, playbackMode)` | Atlas grid config |
| `uFlipbook2` | `(frameDuration, driveSource, renderMode, 0)` | Animation timing |

**Samplers:**
- `sSpriteMap`: The sprite texture (from `/project1/sprite_texture`)

### 4. Billboard Geometry

**Path:** `/project1/billboard_geo`
**Type:** `geoComp`

Contains the quad geometry used for billboard instancing.

**Internal structure:**
```
billboard_geo/
├── quad (gridSOP)  - Unit quad centered at origin
└── out1 (outSOP)   - Output for material reference
```

**Quad parameters:**
- Rows/Cols: 2x2 (single quad)
- Size: 1.0 x 1.0
- Center: 0, 0, 0

### 5. Billboard Instance Render

**Path:** `/project1/billboard_render`
**Type:** `renderTOP`

Renders billboards using instancing from the particle SOP.

**Configuration:**
- Geometry: `/project1/billboard_geo`
- Material: `/project1/billboard_mat`
- Instancing: Enabled
- Instance SOP: `/project1/popnet1/out1` (or your particle output)

**Instance attributes mapping:**
- Color: `Cd` (particle color)
- Scale: `pscale` (particle size)
- Custom 0: `PartVel` (velocity for flipbook)
- Custom 1: `xpartinfo` (age, life, id)

## WebSocket Messages

### sprite_texture

Loads a new sprite texture:
```json
{
  "type": "sprite_texture",
  "assetId": "uuid-string",
  "texturePath": "/path/to/sprite.png"
}
```

Response:
```json
{
  "type": "sprite_loaded",
  "assetId": "uuid-string",
  "success": true
}
```

### flipbook_config

Configures flipbook animation:
```json
{
  "type": "flipbook_config",
  "config": {
    "atlasCols": 4,
    "atlasRows": 4,
    "frameCount": 16,
    "playbackMode": "loop",
    "frameDuration": 0.1,
    "driveSource": "age"
  }
}
```

### render_mode

Switches rendering mode:
```json
{
  "type": "render_mode",
  "mode": "billboard"
}
```

## Flipbook Animation

### Playback Modes

| Mode | Float Value | Behavior |
|------|-------------|----------|
| `loop` | 0 | Frames repeat continuously |
| `once` | 1 | Play once, hold last frame |
| `pingpong` | 2 | Bounce back and forth |
| `random` | 3 | Random frame per particle (based on ID) |

### Drive Sources

| Source | Float Value | Description |
|--------|-------------|-------------|
| `age` | 0 | Particle age in seconds |
| `life` | 1 | Normalized life (0 at birth → 1 at death) |
| `velocity` | 2 | Particle speed |
| `id` | 3 | Unique particle ID (for random) |
| `time` | 4 | Global time |

## Helper Functions (ws_callbacks.py)

```python
# Get flipbook config as vec4 for shader
get_flipbook_vec4()  # → (cols, rows, frameCount, playbackMode)
get_flipbook_vec4_2()  # → (frameDuration, driveSource, renderMode, 0)

# Get current sprite info
get_sprite_asset_id()
get_sprite_texture_path()
get_render_mode()
get_render_mode_float()
```

## Atlas Layout

Supported frame counts and their grid layouts:

| Frames | Grid | Atlas Size |
|--------|------|------------|
| 4 | 2×2 | 256×256 |
| 8 | 4×2 | 512×256 |
| 9 | 3×3 | 384×384 |
| 12 | 4×3 | 512×384 |
| 16 | 4×4 | 512×512 |
| 25 | 5×5 | 640×640 |

Frames are read left-to-right, top-to-bottom.
