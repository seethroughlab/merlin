"""
WebSocket callbacks for Parlor <-> TouchDesigner communication.

Expanded POP system for mirror/echo AR visuals.
"""
import json
import os

# Base path for shader templates (relative to TD project)
# Templates are now at project root level ../shaders (shared with Electron)
SHADER_TEMPLATE_DIR = '../shaders'

# Zone to template file mapping (with prefixes: pop_, top_, mat_)
ZONE_TEMPLATES = {
    'force_field': 'pop_force.glsl',
    'spawn_behavior': 'pop_spawn.glsl',
    'color_over_life': 'pop_color.glsl',
    'size_over_life': 'pop_size.glsl',
    'velocity_modifier': 'pop_velmod.glsl',
    'post_fx': 'top_postfx.glsl',
    'billboard_vertex': 'mat_billboard_vertex.glsl',
    'billboard_pixel': 'mat_billboard_pixel.glsl',
}

# Zone to glslPOP node mapping (particle compute shaders)
ZONE_PATHS = {
    'force_field': '/project1/glsl_force',
    'spawn_behavior': '/project1/glsl_spawn',
    'color_over_life': '/project1/glsl_color',
    'size_over_life': '/project1/glsl_size',
    'velocity_modifier': '/project1/glsl_velmod',
}

# Zone to compute textDAT mapping (particle compute shaders)
ZONE_COMPUTE_PATHS = {
    'force_field': '/project1/glsl_force_compute',
    'spawn_behavior': '/project1/glsl_spawn_compute',
    'color_over_life': '/project1/glsl_color_compute',
    'size_over_life': '/project1/glsl_size_compute',
    'velocity_modifier': '/project1/glsl_velmod_compute',
}

# TOP zones (post-processing shaders)
ZONE_TOP_PATHS = {
    'post_fx': '/project1/glsl_postfx',
}

# TOP zone to code DAT mapping (pixel shader DAT for glslTOP)
ZONE_TOP_CODE_PATHS = {
    'post_fx': '/project1/glsl_postfx_pixel',
}

# MAT zones (material shaders) — billboards only. Mesh-mode work
# (a particle_mat glslMAT) is documented in docs/mesh-mode-pipeline.md
# and currently not part of this project.
ZONE_MAT_PATHS = {
    'billboard_vertex': '/project1/glsl_billboard',
    'billboard_pixel': '/project1/glsl_billboard',
}

# MAT zone to pixel shader DAT mapping
ZONE_MAT_CODE_PATHS = {
    'billboard_pixel': '/project1/glsl_billboard_pixel',
}

# Billboard MAT vertex shader DAT mapping
ZONE_MAT_VERTEX_PATHS = {
    'billboard_vertex': '/project1/glsl_billboard_vertex',
}

# ===== Sprite System Mappings =====

# Playback mode: 0=loop, 1=once, 2=pingpong, 3=random
PLAYBACK_MODE_MAP = {
    'loop': 0,
    'once': 1,
    'pingpong': 2,
    'random': 3,
}

# Drive source: 0=age, 1=life, 2=velocity, 3=id, 4=time
DRIVE_SOURCE_MAP = {
    'age': 0,
    'life': 1,
    'velocity': 2,
    'id': 3,
    'time': 4,
}

tracking_state = {
    'fps': 0,
    'frame_width': 1280,
    'frame_height': 720,
    'portrait': False,
    'pose_detected': False,
    'face_detected': False,
    'face_bbox': [0, 0, 0, 0],
}

# Sprite system state (billboard-only; see docs/mesh-mode-pipeline.md
# for the future-work notes on a separate mesh render path).
sprite_state = {
    'asset_id': None,
    'texture_path': None,
    'sprite_source': 'default',  # 'default' or 'custom'
    # Flipbook config
    'atlas_cols': 1,
    'atlas_rows': 1,
    'frame_count': 1,
    'playback_mode': 'loop',
    'playback_mode_float': 0.0,  # For shader
    'frame_duration': 0.1,
    'drive_source': 'age',
    'drive_source_float': 0.0,  # For shader
}

# ===== Merlin Spell State =====

# Visual mode: -1=idle, 0=buildup, 1=release
SPELL_MODE_MAP = {
    'idle': -1,
    'buildup': 0,
    'release': 1,
}

# Force direction: 0=inward, 1=outward, 2=tangential, 3=upward
FORCE_DIRECTION_MAP = {
    'inward': 0,
    'outward': 1,
    'tangential': 2,
    'upward': 3,
}

# Merlin session state
merlin_state = {
    'active': False,
    'phase': 'idle',
    'mode': 'idle',           # 'idle', 'buildup', 'release'
    'mode_float': -1.0,       # For shader: -1=idle, 0=buildup, 1=release
    'archetype': 'breathing_aura_mist',
}

# Spell-program state (archetype/zone-params layer) was pruned. Visuals
# come entirely from Gemini's set_zone_shader writes; only mode/energy
# from merlin_state + cast_state drive the GLSL uniforms.

# Cast envelope state
cast_state = {
    'trigger': 0.0,           # 0 = not casting, 1 = casting
    'beat': 0.0,              # 0-1 progress through envelope
    'charge_intensity': 0.0,  # Pre-cast charge level
    'ignition_ms': 400,
    'projection_ms': 1200,
    'afterglow_ms': 2900,
    'peak_intensity': 1.0,
    'start_time': 0.0,        # absTime.seconds when cast started
    'duration_ms': 4500,
}


def on_cast_peak_done():
    """Called by /project1/cast_peak_timer when its length expires
    (the peak hold is ~1.2s, configured on the timer node itself).

    Resets spell_state['mode_float'] back to -1.0 (idle); the LagCHOP
    smoothly decays uSpellEnergy down to the idle floor over fallMs.
    This replaces a Node-side setTimeout so the cast envelope is fully
    TD-native and robust to Node disconnects.
    """
    table = op('/project1/spell_state')
    if table is None:
        return
    mode_row = table.findCell('mode_float', cols=[0])
    if mode_row is None:
        return
    table[mode_row.row, 1] = '-1.0'
    m_row = table.findCell('mode', cols=[0])
    if m_row is not None:
        table[m_row.row, 1] = 'idle'
    print('[WS] Cast peak hold expired — mode_float -> -1.0')


def _seed_spell_state_defaults():
    """Ensure tween / peak / sprite-color rows exist in spell_state so the
    expressions wired by _wire_spell_state_uniforms have valid values to
    read on first cook.

    Only writes rows that are missing — preserves any values already set
    by a prior set_cast_params / sprite_colors call. Idempotent; safe to
    call on every connect.

    sprite_color1/2 default to white (1.0, 1.0, 1.0) so zone code that
    references uSpriteColor1/uSpriteColor2 before generate_sprite has been
    called gets a neutral color rather than black.
    """
    table = op('/project1/spell_state')
    if table is None:
        return
    defaults = {
        'tween_rise_ms': '600',
        'tween_fall_ms': '800',
        'peak_energy': '1.0',
        # Sprite palette (white baseline; overwritten by handle_sprite_colors)
        'sprite_color1_r': '1.0', 'sprite_color1_g': '1.0', 'sprite_color1_b': '1.0',
        'sprite_color2_r': '1.0', 'sprite_color2_g': '1.0', 'sprite_color2_b': '1.0',
        # Hand gesture derived signals — written every frame by
        # handle_tracking_frame from wrist landmarks. Defaults safe for
        # zone code that references them before a body is detected.
        'hands_distance': '1.0',   # large = hands apart; near-zero = together
        'hands_vel_mag': '0.0',    # higher = hands moving faster
        'hands_smooth': '0.5',     # 1.0 = silky smooth, 0.0 = jerky
    }
    for key, val in defaults.items():
        if table.findCell(key, cols=[0]) is None:
            update_table_kv(table, key, val)


def _wire_spell_state_uniforms():
    """Bind uSpellEnergy / uSpellMode on every shader op to live
    expressions reading from /project1/spell_state. Without this the
    uniforms sit at hardcoded constants (e.g. uSpellEnergy=0.7) and the
    shaders never reflect actual spell state. Idempotent — safe to call
    on every connect.

    Bindings live on the Vectors page (`vec*name` / `vec*valuex`).
    glslMAT in particular ignores Constants-page assignments and emits
    "Uniform not assigned. Please assign it on the Colors or Vectors
    page." if the uniform isn't on Vectors. To stay consistent across
    glslTOP/glslPOP/glslMAT we always use Vectors. Any stray
    Constants-page name from older runs gets cleared so we don't end up
    with the same uniform claimed in two slots.
    """
    # uSpellEnergy reads from the smoothed CHOP chain (mode → lag → remap)
    # so cast transitions ramp instead of snap. See improvement-02-energy-tweens.md.
    energy_expr = "op('/project1/spell_energy_remap')['chan1'] if op('/project1/spell_energy_remap') is not None else 0.5"
    mode_expr = "float(op('/project1/spell_state')['mode_float', 1]) if op('/project1/spell_state').numRows > 1 else 0"

    # uSpriteColor1 / uSpriteColor2 are vec3 uniforms — three component
    # expressions each, one per channel reading the seeded spell_state rows.
    # See improvement-05-palette-sync.md.
    def _color_expr(row):
        return (
            f"float(op('/project1/spell_state')['{row}', 1]) "
            f"if op('/project1/spell_state').findCell('{row}', cols=[0]) is not None else 1.0"
        )

    # Probe a known-good parameter to discover the EXPRESSION / CONSTANT
    # mode enums without an explicit import (TD versions vary).
    probe = op('/project1/glsl_postfx')
    if probe is None:
        return
    par_mode = type(probe.par.vec1valuex.mode)
    expression_mode = par_mode.EXPRESSION
    constant_mode = par_mode.CONSTANT

    # UNIFORMS maps name -> dict of component expressions. Float uniforms
    # set only 'x'; vec3 uniforms set 'x', 'y', 'z'.
    # Hand gesture scalars — written every frame by _update_hand_gestures
    # from MediaPipe wrist landmarks. Float uniforms (only 'x' set).
    def _scalar_expr(row, default='0.0'):
        return (
            f"float(op('/project1/spell_state')['{row}', 1]) "
            f"if op('/project1/spell_state').findCell('{row}', cols=[0]) is not None else {default}"
        )

    # Each uniform: {'type': 'float'|'vec2'|'vec3'|'vec4', 'components': {x:expr, y:expr,...}}
    # The 'type' field maps to the glsl op's vec{i}type parameter — without
    # setting it, TD defaults to 'float' and ignores y/z/w even if they're
    # populated. That's exactly why uSpriteColor1/2 were compiling as float
    # despite having all three component values wired.
    UNIFORMS = {
        'uSpellEnergy':   {'type': 'float', 'components': {'x': energy_expr}},
        'uSpellMode':     {'type': 'float', 'components': {'x': mode_expr}},
        'uSpriteColor1':  {'type': 'vec3', 'components': {
            'x': _color_expr('sprite_color1_r'),
            'y': _color_expr('sprite_color1_g'),
            'z': _color_expr('sprite_color1_b'),
        }},
        'uSpriteColor2':  {'type': 'vec3', 'components': {
            'x': _color_expr('sprite_color2_r'),
            'y': _color_expr('sprite_color2_g'),
            'z': _color_expr('sprite_color2_b'),
        }},
        'uHandsDistance': {'type': 'float', 'components': {'x': _scalar_expr('hands_distance', '1.0')}},
        'uHandsVelMag':   {'type': 'float', 'components': {'x': _scalar_expr('hands_vel_mag', '0.0')}},
        'uHandsSmooth':   {'type': 'float', 'components': {'x': _scalar_expr('hands_smooth', '0.5')}},
    }

    def wire_op(node, slots=8):
        # Pass 1: clear any Constants-page entries we may have stamped
        # in past runs (TD silently ignores them on glslMAT, leaving
        # ghost names sitting around).
        for i in range(slots):
            namepar = getattr(node.par, f'const{i}name', None)
            valpar = getattr(node.par, f'const{i}value', None)
            if namepar is None or valpar is None:
                continue
            if namepar.eval() in UNIFORMS:
                namepar.val = ''
                valpar.mode = constant_mode
                valpar.expr = ''
                valpar.val = 0.0

        # Pass 2: ensure each uniform is bound on the Vectors page —
        # update an existing slot if already named, otherwise claim the
        # first free vec slot.
        existing = {}  # name -> slot index
        free_slots = []
        for i in range(slots):
            namepar = getattr(node.par, f'vec{i}name', None)
            if namepar is None:
                continue
            nm = namepar.eval()
            if nm:
                existing[nm] = i
            else:
                free_slots.append(i)

        for uniform_name, spec in UNIFORMS.items():
            components = spec['components']
            utype = spec['type']
            if uniform_name in existing:
                slot = existing[uniform_name]
            elif free_slots:
                slot = free_slots.pop(0)
                getattr(node.par, f'vec{slot}name').val = uniform_name
            else:
                # No room — node has all 8 vec slots claimed by other
                # uniforms. Skip; warning will surface in TD.
                continue
            # Set the explicit uniform type. Without this, TD defaults to
            # 'float' and declares the uniform as `uniform float NAME`
            # regardless of how many value components are populated.
            typepar = getattr(node.par, f'vec{slot}type', None)
            if typepar is not None:
                typepar.val = utype
            for comp, expr in components.items():
                valpar = getattr(node.par, f'vec{slot}value{comp}', None)
                if valpar is not None:
                    valpar.expr = expr
                    valpar.mode = expression_mode

    targets = [
        '/project1/glsl_force',
        '/project1/glsl_color',
        '/project1/glsl_size',
        '/project1/glsl_spawn',
        '/project1/glsl_velmod',
        '/project1/glsl_postfx',
        '/project1/glsl_billboard',
    ]
    for path in targets:
        n = op(path)
        if n is not None:
            wire_op(n)

    print("[WS] Wired uSpellEnergy / uSpellMode / uSpriteColor1/2 uniforms to spell_state (Vectors page)")
    # Diagnostic: confirm uSpriteColor1/2 actually landed on a slot with vec3 type.
    probe_node = op('/project1/glsl_color')
    if probe_node is not None:
        for uniform_name in ('uSpriteColor1', 'uSpriteColor2'):
            slot = None
            for i in range(8):
                np = getattr(probe_node.par, f'vec{i}name', None)
                if np is not None and np.eval() == uniform_name:
                    slot = i
                    break
            if slot is not None:
                tp = getattr(probe_node.par, f'vec{slot}type', None)
                tval = tp.eval() if tp is not None else '<no type param>'
                print(f"[WS] {uniform_name} -> glsl_color vec{slot} type={tval}")
            else:
                print(f"[WS] {uniform_name} NOT_BOUND on glsl_color")


def _wire_info_dats():
    """Ensure each glsl_*_info DAT's `op` parameter points at its matching
    GLSL op. This is what `_check_glsl_compile` reads to surface real
    GLSL compiler errors (line numbers, identifiers, type mismatches)
    back to Gemini for retry. If the info DAT is wired to the wrong op,
    we silently fall back to .errors() which only returns the useless
    generic "Compile failed (/path)" string — and Gemini retries blind.
    Idempotent — safe to run on every connect.
    """
    expected = {
        '/project1/glsl_force_info':     '/project1/glsl_force',
        '/project1/glsl_color_info':     '/project1/glsl_color',
        '/project1/glsl_size_info':      '/project1/glsl_size',
        '/project1/glsl_spawn_info':     '/project1/glsl_spawn',
        '/project1/glsl_velmod_info':    '/project1/glsl_velmod',
        '/project1/glsl_postfx_info':    '/project1/glsl_postfx',
        '/project1/glsl_billboard_info': '/project1/glsl_billboard',
    }
    fixed = []
    for info_path, target in expected.items():
        info = op(info_path)
        if info is None:
            continue
        op_par = getattr(info.par, 'op', None)
        if op_par is None:
            continue
        if op_par.eval() != target:
            op_par.val = target
            fixed.append(info_path)
    if fixed:
        print(f"[WS] Re-wired info DATs: {fixed}")


def onConnect(dat):
    print(f"[WS] Connected to Merlin")

    # Self-heal: seed tween/peak defaults so the energy CHOP network has
    # valid expressions on first cook (must run BEFORE the uniform wire,
    # since the expression update depends on spell_energy_remap existing).
    try:
        _seed_spell_state_defaults()
    except Exception as e:
        print(f"[WS] Failed to seed spell_state defaults: {e}")

    # Self-heal: ensure uSpellEnergy / uSpellMode read live from spell_state.
    try:
        _wire_spell_state_uniforms()
    except Exception as e:
        print(f"[WS] Failed to wire spell_state uniforms: {e}")

    # Self-heal: ensure each glsl_*_info DAT points at the right GLSL op
    # so compile errors actually flow back to Gemini.
    try:
        _wire_info_dats()
    except Exception as e:
        print(f"[WS] Failed to wire info DATs: {e}")

    # Check which templates are available
    available_zones = []
    for zone in ZONE_TEMPLATES:
        template, error = load_shader_template(zone)
        if template:
            available_zones.append(zone)

    ready_msg = json.dumps({
        "type": "td_ready",
        "capabilities": {
            "hasParticles": True,
            "hasAura": True,
            "hasSkeletonOverlay": True,
            "hasAnalysis": True,
            "hasTemplates": True,
            "availableZones": available_zones
        }
    })
    dat.sendText(ready_msg)
    print(f"[WS] Zones with templates: {available_zones}")


def onDisconnect(dat):
    print(f"[WS] Disconnected from Parlor")


def onReceiveText(dat, rowIndex, message):
    try:
        msg = json.loads(message)
        msg_type = msg.get('type', '')

        if msg_type == 'ping':
            dat.sendText('{"type":"pong"}')
        elif msg_type == 'zone_update':
            handle_zone_update(dat, msg)
        elif msg_type == 'orientation_update':
            handle_orientation_update(msg)
        elif msg_type == 'tracking_frame':
            handle_tracking_frame(msg)
        # Merlin spell messages
        elif msg_type == 'merlin_state':
            handle_merlin_state(msg)
        elif msg_type == 'spell_charge':
            handle_spell_charge(msg)
        elif msg_type == 'spell_cast':
            handle_spell_cast(msg)
        # Metrics and screenshot requests
        elif msg_type == 'request_metrics':
            handle_request_metrics(dat)
        elif msg_type == 'request_screenshot':
            handle_request_screenshot(dat)
        # Sprite system messages
        elif msg_type == 'sprite_texture':
            handle_sprite_texture(dat, msg)
        elif msg_type == 'flipbook_config':
            handle_flipbook_config(dat, msg)
        elif msg_type == 'reset_sprite':
            handle_reset_sprite(dat, msg)
        elif msg_type == 'set_cast_params':
            handle_set_cast_params(msg)
        elif msg_type == 'set_particle_params':
            handle_particle_params(msg)
        elif msg_type == 'sprite_colors':
            handle_sprite_colors(msg)

    except Exception as e:
        print(f"[WS] Error: {e}")


def load_shader_template(zone):
    """Load a shader template file and return its contents."""
    if zone not in ZONE_TEMPLATES:
        return None, f"Unknown zone: {zone}"

    template_file = ZONE_TEMPLATES[zone]
    template_path = os.path.join(project.folder, SHADER_TEMPLATE_DIR, template_file)

    try:
        with open(template_path, 'r') as f:
            return f.read(), None
    except FileNotFoundError:
        return None, f"Template not found: {template_path}"
    except Exception as e:
        return None, f"Error reading template: {e}"


def merge_shader_template(template, zone_code):
    """Merge zone_code snippet into template at {zone_code} placeholder."""
    if '{zone_code}' not in template:
        return None, "Template missing {zone_code} placeholder"

    # Replace placeholder with custom code (or empty if no custom code)
    merged = template.replace('{zone_code}', zone_code if zone_code else '')
    return merged, None


def _check_glsl_compile(glsl_op):
    """Determine compile success for a GLSL op (POP / TOP / MAT).

    Strategy:
    1. ALWAYS scan the sibling `_info` DAT first for "ERROR:" lines. The
       info DAT contains the actual GLSL compiler output — line numbers,
       offending identifiers, type mismatches — which is what Gemini
       needs to fix the shader. The .errors() method only returns a
       generic "Compile failed (/project1/glsl_force)" summary that is
       useless for retry guidance.
    2. Fall back to .errors() text if there are no ERROR lines in _info
       (covers TD versions / op types where the info DAT layout differs).
    3. Fall back to warnings() containing "compile error".

    Returns (ok, error_text_or_none).
    """
    info_dat = op(glsl_op.path + '_info')
    if info_dat and info_dat.text:
        error_lines = [l for l in info_dat.text.splitlines() if 'ERROR' in l]
        if error_lines:
            return False, '\n'.join(error_lines)

    errors = glsl_op.errors()
    if errors:
        return False, errors

    warnings = glsl_op.warnings() if hasattr(glsl_op, 'warnings') else ''
    if warnings and 'compile error' in str(warnings).lower():
        return False, str(warnings)

    return True, None


def handle_zone_update(dat, msg):
    """Handle zone_update message with template-based shader compilation.

    Message format:
    {
        "type": "zone_update",
        "zone": "force_field",
        "zone_code": "// custom GLSL snippet to insert"
    }

    The zone_code is merged into the canonical template at {zone_code} marker.
    Supports both POP zones (particle compute) and TOP zones (post-processing).
    """
    zone = msg.get('zone', '')
    zone_code = msg.get('zone_code', '')  # Custom snippet from Gemini

    # Legacy support: if glsl_code is provided, use it directly
    if 'glsl_code' in msg and msg['glsl_code']:
        full_shader = msg['glsl_code']
    else:
        # Load template and merge with zone_code
        template, error = load_shader_template(zone)
        if error:
            send_compile_result(dat, zone, False, error)
            return

        full_shader, error = merge_shader_template(template, zone_code)
        if error:
            send_compile_result(dat, zone, False, error)
            return

    # Check if this is a TOP zone (post-processing)
    if zone in ZONE_TOP_PATHS:
        handle_top_zone_update(dat, zone, full_shader)
        return

    # Check if this is a MAT zone (material shader)
    if zone in ZONE_MAT_PATHS:
        handle_mat_zone_update(dat, zone, full_shader)
        return

    # Handle POP zone (particle compute shader)
    if zone not in ZONE_COMPUTE_PATHS:
        send_compile_result(dat, zone, False, f"Unknown zone: {zone}")
        return

    compute_dat = op(ZONE_COMPUTE_PATHS[zone])
    glsl_pop = op(ZONE_PATHS[zone])

    if not compute_dat or not glsl_pop:
        send_compile_result(dat, zone, False, f"Zone not found: {zone}")
        return

    # Write merged shader to textDAT, then cook the chain in order:
    #   1. compute_dat — propagate the new text through TD's eval graph
    #   2. particle1 (parent POP network) — without this, TDIn_PartId()
    #      and other per-particle intrinsics aren't available to the
    #      compute shader's compiler, producing the maddening
    #      `'TDIn_PartId' : no matching overloaded function found`
    #      error at line 6 even though the snippet is identical to one
    #      that compiled fine a moment earlier.
    #   3. glsl_pop — finally compile the merged shader against a fresh
    #      particle context.
    compute_dat.text = full_shader
    compute_dat.cook(force=True)
    particle = op('/project1/particle1')
    if particle:
        particle.cook(force=True)
    glsl_pop.cook(force=True)

    ok, err = _check_glsl_compile(glsl_pop)

    # One retry pass for the specific TDIn_PartId / per-particle-intrinsic
    # races that can occur right after pushParticleParams or other
    # particle1-mutating messages. Re-cooking particle1 then glsl_pop
    # gives TD a second chance to fully wire up the particle inputs
    # before compile. Empirically this clears the error in the common
    # case where the next push happened too quickly after a particle
    # params update.
    if not ok and err and 'TDIn_PartId' in err and particle:
        print(f"[WS] Zone '{zone}' hit TDIn_PartId race — retrying after extra particle1 cook")
        particle.cook(force=True)
        glsl_pop.cook(force=True)
        ok, err = _check_glsl_compile(glsl_pop)

    send_compile_result(dat, zone, ok, err)
    if ok:
        print(f"[WS] Zone '{zone}' updated successfully")


def handle_top_zone_update(dat, zone, full_shader):
    """Handle TOP zone (post-processing shader) update."""
    if zone not in ZONE_TOP_CODE_PATHS:
        send_compile_result(dat, zone, False, f"Unknown TOP zone: {zone}")
        return

    code_dat = op(ZONE_TOP_CODE_PATHS[zone])
    glsl_top = op(ZONE_TOP_PATHS[zone])

    if not code_dat or not glsl_top:
        send_compile_result(dat, zone, False, f"TOP zone not found: {zone}")
        return

    # Write shader to code DAT, then cook in order (code_dat first to
    # propagate the new text, then glsl_top to read it). See
    # handle_zone_update for why the explicit code_dat cook matters.
    code_dat.text = full_shader
    code_dat.cook(force=True)
    glsl_top.cook(force=True)

    ok, err = _check_glsl_compile(glsl_top)
    send_compile_result(dat, zone, ok, err)
    if ok:
        print(f"[WS] TOP zone '{zone}' updated successfully")


def handle_mat_zone_update(dat, zone, full_shader):
    """Handle MAT zone (material pixel or vertex shader) update."""
    # Vertex zones (e.g. billboard_vertex) target a separate textDAT.
    if zone in ZONE_MAT_VERTEX_PATHS:
        code_dat = op(ZONE_MAT_VERTEX_PATHS[zone])
    elif zone in ZONE_MAT_CODE_PATHS:
        code_dat = op(ZONE_MAT_CODE_PATHS[zone])
    else:
        send_compile_result(dat, zone, False, f"Unknown MAT zone: {zone}")
        return

    glsl_mat = op(ZONE_MAT_PATHS[zone])

    if not code_dat or not glsl_mat:
        send_compile_result(dat, zone, False, f"MAT zone not found: {zone}")
        return

    # Write shader to the appropriate code DAT (pixel or vertex), then
    # cook in order (code_dat first, glsl_mat second). See
    # handle_zone_update for why the explicit code_dat cook matters.
    code_dat.text = full_shader
    code_dat.cook(force=True)
    glsl_mat.cook(force=True)

    ok, err = _check_glsl_compile(glsl_mat)
    send_compile_result(dat, zone, ok, err)
    if ok:
        print(f"[WS] MAT zone '{zone}' updated successfully")


def send_compile_result(dat, zone, success, error=None):
    result = {"type": "compile_result", "zone": zone, "success": success}
    if error:
        result["error"] = error
    dat.sendText(json.dumps(result))


def handle_orientation_update(msg):
    w = msg.get('width', 1280)
    h = msg.get('height', 720)
    portrait = msg.get('portrait', False)

    print(f"[WS] Orientation update: {w}x{h} portrait={portrait}")

    # Update resolution_state table
    res_state = op('/project1/resolution_state')
    if res_state:
        res_state['width', 1] = w
        res_state['height', 1] = h
        res_state['portrait', 1] = 1 if portrait else 0

    # Update skeleton_glsl_tex resolution and uniform
    glsl = op('/project1/skeleton_glsl_tex')
    if glsl:
        glsl.par.resolutionw = w
        glsl.par.resolutionh = h
        glsl.par.vec0valuex = w
        glsl.par.vec0valuey = h


# Ring buffer for hand-gesture derivatives. Module-level so the state
# survives across frames. Each entry is (timestamp, mid_x, mid_y, mid_z)
# where mid is the midpoint of the two wrist landmarks.
_hand_history = []
_HAND_HISTORY_MAX = 8  # ~8 frames @ MediaPipe ~30fps ≈ 250ms window

# Smoothness mapping: jerk magnitude below LO is "silky" (1.0); above HI
# is "jerky" (0.0). Tuned for normalized MediaPipe coordinates where
# wrist positions sit in [0,1].
_HAND_JERK_LO = 0.02
_HAND_JERK_HI = 0.12


def _update_hand_gestures(landmarks, spell_table):
    """Compute hands_distance / hands_vel_mag / hands_smooth from the
    current frame's wrist landmarks (indices 15 = L wrist, 16 = R wrist
    in MediaPipe Pose) plus a short history. Writes the three scalars
    back to spell_state for the uniform wiring to pick up.

    Skipped silently if either wrist has visibility < 0.3 — the previous
    frame's values stay in place. This keeps a brief tracking dropout
    from snapping uniforms to defaults mid-spell.
    """
    if spell_table is None or not landmarks or len(landmarks) < 17:
        return

    L = landmarks[15]
    R = landmarks[16]
    L_vis = L[3] if len(L) > 3 else 1.0
    R_vis = R[3] if len(R) > 3 else 1.0
    if L_vis < 0.3 or R_vis < 0.3:
        return

    Lx, Ly, Lz = L[0], L[1], (L[2] if len(L) > 2 else 0.0)
    Rx, Ry, Rz = R[0], R[1], (R[2] if len(R) > 2 else 0.0)

    # Current-frame distance and midpoint.
    dx, dy, dz = Lx - Rx, Ly - Ry, Lz - Rz
    distance = (dx * dx + dy * dy + dz * dz) ** 0.5
    mid = (0.5 * (Lx + Rx), 0.5 * (Ly + Ry), 0.5 * (Lz + Rz))

    now = absTime.seconds
    _hand_history.append((now, mid[0], mid[1], mid[2]))
    while len(_hand_history) > _HAND_HISTORY_MAX:
        _hand_history.pop(0)

    # Velocity magnitudes (Δmid / Δt) across consecutive samples.
    vels = []
    for i in range(1, len(_hand_history)):
        t0 = _hand_history[i - 1][0]
        t1 = _hand_history[i][0]
        dt = t1 - t0
        if dt <= 0:
            continue
        vx = (_hand_history[i][1] - _hand_history[i - 1][1]) / dt
        vy = (_hand_history[i][2] - _hand_history[i - 1][2]) / dt
        vz = (_hand_history[i][3] - _hand_history[i - 1][3]) / dt
        vels.append((vx, vy, vz, (vx * vx + vy * vy + vz * vz) ** 0.5))

    vel_mag = sum(v[3] for v in vels) / len(vels) if vels else 0.0

    # Jerk = change in velocity vector between consecutive samples.
    jerk_mags = []
    for i in range(1, len(vels)):
        jx = vels[i][0] - vels[i - 1][0]
        jy = vels[i][1] - vels[i - 1][1]
        jz = vels[i][2] - vels[i - 1][2]
        jerk_mags.append((jx * jx + jy * jy + jz * jz) ** 0.5)
    jerk_mag = sum(jerk_mags) / len(jerk_mags) if jerk_mags else 0.0

    # Smoothness: invert jerk through smoothstep.
    if jerk_mag <= _HAND_JERK_LO:
        smooth = 1.0
    elif jerk_mag >= _HAND_JERK_HI:
        smooth = 0.0
    else:
        t = (jerk_mag - _HAND_JERK_LO) / (_HAND_JERK_HI - _HAND_JERK_LO)
        smooth = 1.0 - (t * t * (3.0 - 2.0 * t))

    update_table_kv(spell_table, 'hands_distance', f'{distance:.4f}')
    update_table_kv(spell_table, 'hands_vel_mag', f'{vel_mag:.4f}')
    update_table_kv(spell_table, 'hands_smooth', f'{smooth:.4f}')


def handle_tracking_frame(msg):
    """Write landmarks to tableDAT (most stable for TD)."""
    global tracking_state

    tracking_state['fps'] = msg.get('fps', 0)

    frame = msg.get('frame', {})
    tracking_state['frame_width'] = frame.get('width', 1280)
    tracking_state['frame_height'] = frame.get('height', 720)
    tracking_state['portrait'] = frame.get('portrait', False)

    pose = msg.get('pose', {})
    tracking_state['pose_detected'] = pose.get('detected', False)
    landmarks = pose.get('landmarks', [])

    face = msg.get('face', {})
    tracking_state['face_detected'] = face.get('detected', False)
    tracking_state['face_bbox'] = face.get('bbox', [0, 0, 0, 0])

    # Update pose detected uniform
    glsl = op('/project1/skeleton_glsl')
    if glsl:
        glsl.par.const0value = 1 if tracking_state['pose_detected'] else 0

    # Write landmarks to tableDAT
    table = op('/project1/landmark_table')
    if table and landmarks:
        for i in range(min(33, len(landmarks))):
            row = i + 1  # Skip header
            lm = landmarks[i]
            table[row, 0] = lm[0]
            table[row, 1] = lm[1]
            table[row, 2] = lm[2] if len(lm) > 2 else 0
            table[row, 3] = lm[3] if len(lm) > 3 else 1

    # Update derived hand-gesture signals on spell_state.
    _update_hand_gestures(landmarks, op('/project1/spell_state'))


def handle_merlin_state(msg):
    """Handle merlin_state message - session activation, phase, and the
    phase-driven mode for the energy tween.

    Phase implies the resting mode for the energy CHOP: 'idle' means the
    spell isn't casting, so mode_float=-1.0 lets the LagCHOP fall back to
    the idle floor (~0.2 after remap). This is what request_visual_feedback's
    captureTemporalFrames uses to restore baseline after the peak shot.
    Other phases leave mode/mode_float untouched — handle_spell_cast is
    still the only writer for the +1.0 release pulse.
    """
    global merlin_state

    merlin_state['active'] = msg.get('active', False)
    if 'phase' in msg:
        merlin_state['phase'] = msg['phase']
        if msg['phase'] == 'idle':
            merlin_state['mode'] = 'idle'
            merlin_state['mode_float'] = -1.0

    # Update spell_state tableDAT
    table = op('/project1/spell_state')
    if table:
        update_table_kv(table, 'active', '1' if merlin_state['active'] else '0')
        update_table_kv(table, 'phase', merlin_state['phase'])
        # Mirror mode/mode_float when phase forced them (keeps the energy
        # CHOP expression consistent with what handle_spell_cast writes).
        if msg.get('phase') == 'idle':
            update_table_kv(table, 'mode', merlin_state['mode'])
            update_table_kv(table, 'mode_float', str(merlin_state['mode_float']))

    print(f"[WS] Merlin: active={merlin_state['active']} phase={merlin_state['phase']} mode={merlin_state['mode']}")


def handle_spell_charge(msg):
    """Handle spell_charge message - pre-cast particle tightening."""
    global cast_state

    cast_state['charge_intensity'] = msg.get('intensity', 0.5)
    casting_origin = msg.get('origin')

    # Update spell_state tableDAT
    table = op('/project1/spell_state')
    if table:
        update_table_kv(table, 'charge_intensity', str(cast_state['charge_intensity']))
        update_table_kv(table, 'casting_origin', str(casting_origin or ''))

    print(f"[WS] Spell charge: origin={casting_origin} intensity={cast_state['charge_intensity']:.2f}")


def handle_spell_cast(msg):
    """Handle spell_cast message - trigger the release envelope."""
    global merlin_state, cast_state

    # Switch to release mode
    merlin_state['mode'] = 'release'
    merlin_state['mode_float'] = 1.0

    # Set cast trigger
    cast_state['trigger'] = 1.0
    cast_state['beat'] = 0.0
    cast_state['start_time'] = absTime.seconds

    # Extract envelope timing
    envelope = msg.get('envelope', {})
    cast_state['ignition_ms'] = envelope.get('ignitionMs', 400)
    cast_state['projection_ms'] = envelope.get('projectionMs', 1200)
    cast_state['afterglow_ms'] = envelope.get('afterglowMs', 2900)
    cast_state['peak_intensity'] = envelope.get('peakIntensity', 1.0)
    cast_state['duration_ms'] = msg.get('durationMs', 4500)

    # Update spell_state tableDAT
    table = op('/project1/spell_state')
    if table:
        update_table_kv(table, 'mode', 'release')
        update_table_kv(table, 'mode_float', '1.0')
        update_table_kv(table, 'cast_trigger', '1.0')
        update_table_kv(table, 'cast_beat', '0.0')
        update_table_kv(table, 'cast_start_time', str(cast_state['start_time']))
        update_table_kv(table, 'ignition_ms', str(cast_state['ignition_ms']))
        update_table_kv(table, 'projection_ms', str(cast_state['projection_ms']))
        update_table_kv(table, 'afterglow_ms', str(cast_state['afterglow_ms']))
        update_table_kv(table, 'peak_intensity', str(cast_state['peak_intensity']))
        update_table_kv(table, 'duration_ms', str(cast_state['duration_ms']))
        # Energy is no longer written directly here — uSpellEnergy is now
        # driven by a TD-side LagCHOP that reads mode_float and smooths it
        # using tween_rise_ms / tween_fall_ms / peak_energy. See
        # docs/improvement-02-energy-tweens.md.

    # Start the TD-side peak-hold timer. When it expires, the
    # cast_peak_timer_callbacks DAT calls back to on_cast_peak_done()
    # which resets mode_float to -1.0 and lets the LagCHOP decay
    # uSpellEnergy back to idle. Pulsing `start` while the timer is
    # already running re-triggers it (rapid re-casts hold peak as
    # long as the participant keeps casting).
    timer = op('/project1/cast_peak_timer')
    if timer is not None:
        timer.par.start.pulse(1)

    o = msg.get('origin', 'unknown')
    d = cast_state['duration_ms']
    print(f"[WS] SPELL CAST! origin={o} duration={d}ms")


def handle_set_cast_params(msg):
    """Handle set_cast_params message - configure the energy tween envelope.

    Writes tween_rise_ms / tween_fall_ms / peak_energy to spell_state so the
    TD-side LagCHOP + MathCHOP read fresh values on the next cook. All
    fields are optional; absent fields keep the existing table value.
    """
    table = op('/project1/spell_state')
    if not table:
        return

    if 'riseMs' in msg:
        update_table_kv(table, 'tween_rise_ms', str(msg['riseMs']))
    if 'fallMs' in msg:
        update_table_kv(table, 'tween_fall_ms', str(msg['fallMs']))
    if 'peakEnergy' in msg:
        update_table_kv(table, 'peak_energy', str(msg['peakEnergy']))

    print(
        f"[WS] Cast params: rise={msg.get('riseMs', '-')}ms "
        f"fall={msg.get('fallMs', '-')}ms peak={msg.get('peakEnergy', '-')}"
    )


def handle_sprite_colors(msg):
    """Handle sprite_colors message - update uSpriteColor1/2 vec3 uniforms.

    Writes 6 normalized RGB values into spell_state rows
    sprite_color{1,2}_{r,g,b}. The expressions wired by
    _wire_spell_state_uniforms read these rows on every cook so the
    uniforms refresh as soon as the table updates.

    Pushed automatically after every successful generate_sprite call;
    reset to white at baseline via BASELINE_PALETTE.
    """
    table = op('/project1/spell_state')
    if not table:
        return

    c1 = msg.get('color1') or {}
    c2 = msg.get('color2') or {}
    if 'r' in c1: update_table_kv(table, 'sprite_color1_r', str(c1['r']))
    if 'g' in c1: update_table_kv(table, 'sprite_color1_g', str(c1['g']))
    if 'b' in c1: update_table_kv(table, 'sprite_color1_b', str(c1['b']))
    if 'r' in c2: update_table_kv(table, 'sprite_color2_r', str(c2['r']))
    if 'g' in c2: update_table_kv(table, 'sprite_color2_g', str(c2['g']))
    if 'b' in c2: update_table_kv(table, 'sprite_color2_b', str(c2['b']))

    def _fmt(v):
        return f"{v:.2f}" if isinstance(v, (int, float)) else "-"
    print(
        f"[WS] Sprite colors: primary=({_fmt(c1.get('r'))},{_fmt(c1.get('g'))},{_fmt(c1.get('b'))}) "
        f"accent=({_fmt(c2.get('r'))},{_fmt(c2.get('g'))},{_fmt(c2.get('b'))})"
    )


def handle_particle_params(msg):
    """Handle set_particle_params message - configure the particle sim.

    All fields optional; only the supplied keys mutate node params. Maps
    the camelCase tool args onto TD's native parameter names:
      maxCount    -> particle1.maxparticles
      lifespan    -> particle1.life          (seconds)
      emitRate    -> particle1.birthrate     (per second)
      spawnRadius -> pointgenerator1.radius{x,y,z}  (kept isotropic)
      blendMode   -> glsl_billboard.{srcblend,destblend}
                     'additive' -> one/one (sums brightness)
                     'alpha'    -> sa/omsa (occluding alpha blend)

    Missing nodes are skipped silently so dev-time TD state churn (a
    deleted node from an experiment) doesn't crash the WS handler.
    """
    p1 = op('/project1/particle1')
    if p1 is not None:
        if 'maxCount' in msg:
            p1.par.maxparticles = int(msg['maxCount'])
        if 'lifespan' in msg:
            p1.par.life = float(msg['lifespan'])
        if 'emitRate' in msg:
            p1.par.birthrate = float(msg['emitRate'])

    pg = op('/project1/pointgenerator1')
    if pg is not None and 'spawnRadius' in msg:
        r = float(msg['spawnRadius'])
        pg.par.radiusx = r
        pg.par.radiusy = r
        pg.par.radiusz = r

    mat = op('/project1/glsl_billboard')
    if mat is not None and 'blendMode' in msg:
        bm = msg['blendMode']
        if bm == 'additive':
            mat.par.srcblend = 'one'
            mat.par.destblend = 'one'
        elif bm == 'alpha':
            mat.par.srcblend = 'sa'
            mat.par.destblend = 'omsa'

    print(
        f"[WS] Particle params: count={msg.get('maxCount', '-')} "
        f"life={msg.get('lifespan', '-')}s rate={msg.get('emitRate', '-')}/s "
        f"radius={msg.get('spawnRadius', '-')} blend={msg.get('blendMode', '-')}"
    )


def handle_request_metrics(dat):
    """Handle request_metrics message - send FPS and particle stats."""
    import base64

    # Get FPS from project
    fps = project.cookRate if hasattr(project, 'cookRate') else 60.0

    # Try to get particle count from popnet
    particle_count = 0
    popnet = op('/project1/popnet1')
    if popnet:
        try:
            particle_count = popnet.numParticles
        except:
            pass

    # Calculate coverage (rough estimate based on particle positions)
    coverage = 0.0
    # Could sample from a TOP if needed

    metrics = {
        'type': 'metrics',
        'fps': fps,
        'particle_count': particle_count,
        'coverage': coverage,
    }
    dat.sendText(json.dumps(metrics))


def _emit_visibility_message(dat):
    """Emit a visibility message alongside a screenshot.

    Gives the JS side fresh quantitative ground-truth (visible particle
    count, average particle brightness, particle-render vs webcam diff)
    so Gemini can cross-reference its visual eval with hard numbers.
    Sent as a separate WS message just before the screenshot_result so
    metrics.ts updateVisibility() runs first.
    """
    import numpy as np

    visible_particles = 0
    # particlePOP / nullPOP expose numPoints() as a method (not property);
    # particles_out is the "after spawn-shader" canonical count of live
    # particles. Older logic looked for /project1/popnet1 which doesn't
    # exist in this project.
    pop_count = op('/project1/particles_out') or op('/project1/particle1')
    if pop_count:
        try:
            visible_particles = int(pop_count.numPoints())
        except Exception:
            pass

    avg_brightness = 0.0
    pr = op('/project1/particle_render_out')
    if pr:
        try:
            arr = pr.numpyArray(delayed=False)
            # mean over rgb channels (skip alpha)
            avg_brightness = float(arr[:, :, :3].mean())
        except Exception:
            pass

    render_vs_webcam_diff = 0.0
    # Compare what the user actually sees (out_final) to the raw webcam
    # (syphonspoutin1). Near-zero diff means the spell isn't visibly
    # contributing pixels to the final composite. The compositeTOP
    # "difference" operand turned out to be a photoshop-style blend
    # (centered at midgray), not a raw abs-diff — so do the math in
    # numpy directly. ~3 ms on 720p frames; only runs when Gemini
    # requests visual feedback, so the cost is negligible.
    of = op('/project1/out_final')
    ss = op('/project1/syphonspoutin1')
    if of and ss:
        try:
            of_arr = of.numpyArray(delayed=False)
            ss_arr = ss.numpyArray(delayed=False)
            # If shapes don't match (e.g. webcam not yet streaming at
            # full res), skip — return 0.0 rather than crash.
            if of_arr.shape == ss_arr.shape:
                render_vs_webcam_diff = float(
                    np.abs(of_arr[:, :, :3] - ss_arr[:, :, :3]).mean()
                )
        except Exception:
            pass

    msg = {
        'type': 'visibility',
        'visible_particles': visible_particles,
        'culled_particles': 0,
        'avg_brightness': avg_brightness,
        'render_vs_webcam_diff': render_vs_webcam_diff,
    }
    dat.sendText(json.dumps(msg))


def handle_request_screenshot(dat):
    """Handle request_screenshot message - capture render and send as base64.

    Also emits a visibility message first so the JS side has fresh
    metrics (visible particles / avg brightness / render-vs-webcam diff)
    when it processes the upcoming screenshot.
    """
    import base64

    # Emit visibility metrics before the screenshot. JS side processes
    # messages in order, so updateVisibility runs before the screenshot
    # response handler reads getLatestVisibility().
    try:
        _emit_visibility_message(dat)
    except Exception as e:
        print(f"[WS] visibility-emit error (non-fatal): {e}")

    # Prefer out_final — that's the post-comp output the live experience
    # actually shows. Fall back to earlier render stages if it's missing.
    render_top = op('/project1/out_final')
    if not render_top:
        render_top = op('/project1/render1')
    if not render_top:
        render_top = op('/project1/null_out')
    if not render_top:
        render_top = op('/project1/out1')

    if not render_top:
        print("[WS] Screenshot: No render TOP found (looked for out_final, render1, null_out, out1)")
        return

    try:
        # Save to temp file and read back as base64
        import tempfile
        import os

        temp_path = os.path.join(tempfile.gettempdir(), 'parlor_screenshot.png')
        render_top.save(temp_path)

        with open(temp_path, 'rb') as f:
            image_data = f.read()
            base64_data = base64.b64encode(image_data).decode('utf-8')

        # Get dimensions
        width = render_top.width
        height = render_top.height

        screenshot = {
            'type': 'screenshot_result',
            'base64': base64_data,
            'width': width,
            'height': height,
        }
        dat.sendText(json.dumps(screenshot))
        print(f"[WS] Screenshot sent: {width}x{height}")

        # Clean up temp file
        try:
            os.remove(temp_path)
        except:
            pass

    except Exception as e:
        print(f"[WS] Screenshot error: {e}")


# ===== Sprite System Handlers =====

def handle_sprite_texture(dat, msg):
    """Handle sprite_texture message - load sprite texture into TD.

    Message format:
    {
        "type": "sprite_texture",
        "assetId": "uuid-string",
        "texturePath": "/path/to/sprite.png"
    }
    """
    global sprite_state

    asset_id = msg.get('assetId', '')
    texture_path = msg.get('texturePath', '')

    sprite_state['asset_id'] = asset_id
    sprite_state['texture_path'] = texture_path

    # Try to load texture into sprite_texture TOP
    sprite_top = op('/project1/sprite_texture')
    sprite_switch = op('/project1/sprite_switch')
    success = False
    error = None

    if sprite_top:
        try:
            sprite_top.par.file = texture_path
            sprite_top.cook(force=True)
            success = True

            # Switch to custom sprite (index 1 = sprite_texture)
            if sprite_switch:
                sprite_switch.par.index = 1
                sprite_state['sprite_source'] = 'custom'

            print(f"[WS] Loaded sprite texture: {asset_id}")
        except Exception as e:
            error = str(e)
            print(f"[WS] Failed to load sprite: {e}")
    else:
        error = "sprite_texture TOP not found"
        print(f"[WS] {error}")

    # Update sprite_state tableDAT
    table = op('/project1/sprite_state')
    if table:
        update_table_kv(table, 'asset_id', asset_id)
        update_table_kv(table, 'texture_path', texture_path)
        update_table_kv(table, 'sprite_source', sprite_state['sprite_source'])

    # Send confirmation
    response = {
        'type': 'sprite_loaded',
        'assetId': asset_id,
        'success': success,
    }
    if error:
        response['error'] = error
    dat.sendText(json.dumps(response))


def handle_flipbook_config(dat, msg):
    """Handle flipbook_config message - configure flipbook animation.

    Message format:
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
    """
    global sprite_state

    config = msg.get('config', {})

    # Update sprite state
    sprite_state['atlas_cols'] = config.get('atlasCols', 1)
    sprite_state['atlas_rows'] = config.get('atlasRows', 1)
    sprite_state['frame_count'] = config.get('frameCount', 1)
    sprite_state['playback_mode'] = config.get('playbackMode', 'loop')
    sprite_state['playback_mode_float'] = float(PLAYBACK_MODE_MAP.get(
        sprite_state['playback_mode'], 0
    ))
    sprite_state['frame_duration'] = config.get('frameDuration', 0.1)
    sprite_state['drive_source'] = config.get('driveSource', 'age')
    sprite_state['drive_source_float'] = float(DRIVE_SOURCE_MAP.get(
        sprite_state['drive_source'], 0
    ))

    # Update billboard material uniforms if it exists
    billboard_mat = op('/project1/glsl_billboard')
    if billboard_mat:
        try:
            # uFlipbook1: (cols, rows, frameCount, playbackMode)
            billboard_mat.par.vec1valuex = float(sprite_state['atlas_cols'])
            billboard_mat.par.vec1valuey = float(sprite_state['atlas_rows'])
            billboard_mat.par.vec1valuez = float(sprite_state['frame_count'])
            billboard_mat.par.vec1valuew = sprite_state['playback_mode_float']

            # uFlipbook2: (frameDuration, driveSource, 0, 0)
            # The third slot used to carry renderMode; mesh-mode rendering
            # has been pruned (see docs/mesh-mode-pipeline.md). Left at 0.
            billboard_mat.par.vec2valuex = float(sprite_state['frame_duration'])
            billboard_mat.par.vec2valuey = sprite_state['drive_source_float']
            billboard_mat.par.vec2valuez = 0.0
        except Exception as e:
            print(f"[WS] Error setting billboard mat params: {e}")

    # Update sprite_state tableDAT
    table = op('/project1/sprite_state')
    if table:
        update_table_kv(table, 'atlas_cols', str(sprite_state['atlas_cols']))
        update_table_kv(table, 'atlas_rows', str(sprite_state['atlas_rows']))
        update_table_kv(table, 'frame_count', str(sprite_state['frame_count']))
        update_table_kv(table, 'playback_mode', sprite_state['playback_mode'])
        update_table_kv(table, 'playback_mode_float', str(sprite_state['playback_mode_float']))
        update_table_kv(table, 'frame_duration', str(sprite_state['frame_duration']))
        update_table_kv(table, 'drive_source', sprite_state['drive_source'])
        update_table_kv(table, 'drive_source_float', str(sprite_state['drive_source_float']))

    cols = sprite_state['atlas_cols']
    rows = sprite_state['atlas_rows']
    frames = sprite_state['frame_count']
    mode = sprite_state['playback_mode']
    print(f"[WS] Flipbook config: {cols}x{rows} ({frames} frames, {mode})")


def handle_reset_sprite(dat, msg):
    """Handle reset_sprite message - revert to default feathered circle sprite.

    Message format:
    {
        "type": "reset_sprite"
    }
    """
    success = reset_to_default_sprite()

    # Update billboard material uniforms to single frame
    billboard_mat = op('/project1/glsl_billboard')
    if billboard_mat:
        try:
            # uFlipbook1: (cols, rows, frameCount, playbackMode)
            billboard_mat.par.vec1valuex = 1.0
            billboard_mat.par.vec1valuey = 1.0
            billboard_mat.par.vec1valuez = 1.0
            billboard_mat.par.vec1valuew = 0.0
        except Exception as e:
            print(f"[WS] Error resetting billboard uniforms: {e}")

    response = {
        'type': 'sprite_reset',
        'success': success,
    }
    dat.sendText(json.dumps(response))


# ===== Sprite Helper Functions =====

def get_sprite_asset_id():
    """Get current sprite asset ID."""
    return sprite_state['asset_id']

def get_sprite_texture_path():
    """Get current sprite texture path."""
    return sprite_state['texture_path']

def get_sprite_source():
    """Get sprite source: 'default' or 'custom'."""
    return sprite_state['sprite_source']

def reset_to_default_sprite():
    """Reset to the default feathered circle sprite.

    Switches sprite_switch to input 0 (default_sprite).
    """
    global sprite_state

    sprite_switch = op('/project1/sprite_switch')
    if sprite_switch:
        sprite_switch.par.index = 0
        sprite_state['sprite_source'] = 'default'
        sprite_state['asset_id'] = None
        sprite_state['texture_path'] = None

        # Reset flipbook to single frame
        sprite_state['atlas_cols'] = 1
        sprite_state['atlas_rows'] = 1
        sprite_state['frame_count'] = 1

        # Update sprite_state tableDAT
        table = op('/project1/sprite_state')
        if table:
            update_table_kv(table, 'sprite_source', 'default')
            update_table_kv(table, 'asset_id', '')
            update_table_kv(table, 'texture_path', '')
            update_table_kv(table, 'atlas_cols', '1')
            update_table_kv(table, 'atlas_rows', '1')
            update_table_kv(table, 'frame_count', '1')

        print("[WS] Reset to default sprite")
        return True
    return False

def get_flipbook_config():
    """Get flipbook configuration as a dict."""
    return {
        'atlas_cols': sprite_state['atlas_cols'],
        'atlas_rows': sprite_state['atlas_rows'],
        'frame_count': sprite_state['frame_count'],
        'playback_mode': sprite_state['playback_mode'],
        'playback_mode_float': sprite_state['playback_mode_float'],
        'frame_duration': sprite_state['frame_duration'],
        'drive_source': sprite_state['drive_source'],
        'drive_source_float': sprite_state['drive_source_float'],
    }

def get_flipbook_vec4():
    """Get flipbook uniform as vec4: (cols, rows, frameCount, playbackMode)."""
    return (
        float(sprite_state['atlas_cols']),
        float(sprite_state['atlas_rows']),
        float(sprite_state['frame_count']),
        sprite_state['playback_mode_float'],
    )

def get_flipbook_vec4_2():
    """Get second flipbook uniform as vec4: (frameDuration, driveSource, 0, 0).
    The third slot used to carry renderMode; mesh-mode rendering has been
    pruned (see docs/mesh-mode-pipeline.md). Slot is reserved at 0.
    """
    return (
        sprite_state['frame_duration'],
        sprite_state['drive_source_float'],
        0.0,
        0.0,
    )


def is_pose_detected():
    return tracking_state['pose_detected']

def is_face_detected():
    return tracking_state['face_detected']

def get_frame_dimensions():
    return (tracking_state['frame_width'], tracking_state['frame_height'])

def is_portrait():
    return tracking_state['portrait']

# ===== Merlin Spell Helpers =====

def is_merlin_active():
    """Check if Merlin session is active."""
    return merlin_state['active']

def get_spell_mode():
    """Get spell mode: 'idle', 'buildup', or 'release'."""
    return merlin_state['mode']

def get_spell_mode_float():
    """Get spell mode as float for shaders: -1=idle, 0=buildup, 1=release."""
    return merlin_state['mode_float']

def get_cast_trigger():
    """Get cast trigger (0 or 1)."""
    return cast_state['trigger']

def get_cast_beat():
    """Get cast beat progress (0-1 through envelope)."""
    return cast_state['beat']

def get_charge_intensity():
    """Get pre-cast charge intensity (0-1)."""
    return cast_state['charge_intensity']

def hex_to_rgb(hex_color):
    """Convert hex color to normalized RGB tuple (0-1)."""
    hex_color = hex_color.lstrip('#')
    r = int(hex_color[0:2], 16) / 255.0
    g = int(hex_color[2:4], 16) / 255.0
    b = int(hex_color[4:6], 16) / 255.0
    return (r, g, b)

def get_spell_uniforms():
    """Get the small set of spell-related uniforms zone code can read.
    Most archetype-driven uniforms (force_strength, palette, etc.) were
    pruned along with the archetype layer; visuals come from Gemini's
    set_zone_shader writes, which can compute their own values."""
    return {
        'uSpellMode': merlin_state['mode_float'],
        'uCastTrigger': cast_state['trigger'],
        'uCastBeat': cast_state['beat'],
        'uChargeIntensity': cast_state['charge_intensity'],
    }


def reset_zone_to_template(zone):
    """Reset a zone's shader to the default template (no custom code).

    Returns (success, error_message).
    """
    template, error = load_shader_template(zone)
    if error:
        return False, error

    # Merge with empty zone_code to get default behavior
    full_shader, error = merge_shader_template(template, '')
    if error:
        return False, error

    compute_dat = op(ZONE_COMPUTE_PATHS.get(zone))
    glsl_pop = op(ZONE_PATHS.get(zone))

    if not compute_dat or not glsl_pop:
        return False, f"Zone nodes not found: {zone}"

    compute_dat.text = full_shader
    glsl_pop.cook(force=True)

    errors = glsl_pop.errors()
    if errors:
        return False, errors

    print(f"[WS] Zone '{zone}' reset to template")
    return True, None


def reset_all_zones():
    """Reset all zones to their default templates.

    Returns dict of {zone: (success, error)}.
    """
    results = {}
    for zone in ZONE_TEMPLATES:
        success, error = reset_zone_to_template(zone)
        results[zone] = (success, error)
    return results

def update_table_kv(table_dat, key, value):
    """Generic key/value tableDAT helper. Updates the row whose first
    column matches `key`, or appends a new row if absent."""
    for row in range(table_dat.numRows):
        if table_dat[row, 0].val == key:
            table_dat[row, 1] = value
            return
    table_dat.appendRow([key, value])


def onReceiveBinary(dat, rowIndex, contents):
    pass
