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
    'material_pixel': 'mat_pixel.glsl',
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

# MAT zones (material shaders)
ZONE_MAT_PATHS = {
    'material_pixel': '/project1/particle_mat',
}

# MAT zone to pixel shader DAT mapping
ZONE_MAT_CODE_PATHS = {
    'material_pixel': '/project1/particle_mat_pixel',
}

# Emotion to index mapping for shaders
EMOTION_INDEX = {
    'neutral': 0,
    'joy': 1,
    'fear': 2,
    'anger': 3,
    'sadness': 4,
    'surprise': 5,
}

# Mood to particle force mode mapping
# 0=orbit, 1=attract, 2=repel, 3=emit
MOOD_FORCE_MODE = {
    'mysterious': 0,     # orbit
    'tension': 2,        # repel
    'revelation': 1,     # attract
    'warm': 3,           # emit
    'contemplative': 0,  # orbit
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

mentalist_state = {
    'active': False,
    'phase': 'idle',
    'mood': 'mysterious',
    'color_accent': '#8B5CF6',
    'particle_behavior': 'calm',
}

# Analysis state for mirror/echo visuals
analysis_state = {
    'valence': 0.0,      # -1 (negative) to 1 (positive)
    'arousal': 0.0,      # 0 (calm) to 1 (excited)
    'tension': 0.0,      # 0 (relaxed) to 1 (tense)
    'openness': 0.0,     # -1 (closed) to 1 (open)
    'engagement': 0.0,   # 0 (disengaged) to 1 (engaged)
    'primary_emotion': 'neutral',
    'emotion_index': 0,  # For shader lookup
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

# Spell program state (updated by particle_spell_program messages)
spell_program = {
    'version': '1.0',
    'spell_id': '',
    'intent': None,
    'element': None,
    'archetype': 'breathing_aura_mist',
    'energy': 0.2,
    'energy_floor': 0.1,
    'energy_ceiling': 0.3,
    'casting_origin': None,
    'casting_landmarks': [],
    # Palette (hex colors)
    'palette_primary': '#8B5CF6',
    'palette_secondary': '#A78BFA',
    'palette_accent': '#C4B5FD',
    # Zone params (flattened for easy access)
    'spawn_radius': 0.3,
    'spawn_rate': 0.5,
    'force_strength': 0.1,
    'force_direction': 0,     # 0=inward, 1=outward, 2=tangential, 3=upward
    'orbit_speed': 0.2,
    'turbulence': 0.1,
    'velocity_scale': 0.4,
    'damping': 0.3,
    'base_size': 0.03,
    'size_variation': 0.2,
    'saturation': 0.5,
    'brightness': 0.6,
    'alpha_fade': 0.4,
}

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


def onConnect(dat):
    print(f"[WS] Connected to Parlor")

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
        elif msg_type == 'mood_update':
            handle_mood_update(msg)
        elif msg_type == 'scene_params':
            handle_scene_params(msg.get('params', {}))
        elif msg_type == 'aura_update':
            handle_aura_update(msg)
        elif msg_type == 'reveal_effect':
            handle_reveal_effect(msg)
        elif msg_type == 'skeleton_augment':
            handle_skeleton_augment(msg)
        elif msg_type == 'orientation_update':
            handle_orientation_update(msg)
        elif msg_type == 'tracking_frame':
            handle_tracking_frame(msg)
        elif msg_type == 'mentalist_state':
            handle_mentalist_state(msg)
        elif msg_type == 'analysis_update':
            handle_analysis_update(msg)
        # Merlin spell messages
        elif msg_type == 'merlin_state':
            handle_merlin_state(msg)
        elif msg_type == 'particle_spell_program':
            handle_particle_spell_program(msg)
        elif msg_type == 'spell_charge':
            handle_spell_charge(msg)
        elif msg_type == 'spell_cast':
            handle_spell_cast(msg)
        # Metrics and screenshot requests
        elif msg_type == 'request_metrics':
            handle_request_metrics(dat)
        elif msg_type == 'request_screenshot':
            handle_request_screenshot(dat)

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

    # Write merged shader to textDAT
    compute_dat.text = full_shader
    glsl_pop.cook(force=True)

    errors = glsl_pop.errors()
    if errors:
        send_compile_result(dat, zone, False, errors)
    else:
        send_compile_result(dat, zone, True)
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

    # Write shader to code DAT
    code_dat.text = full_shader
    glsl_top.cook(force=True)

    errors = glsl_top.errors()
    if errors:
        send_compile_result(dat, zone, False, errors)
    else:
        send_compile_result(dat, zone, True)
        print(f"[WS] TOP zone '{zone}' updated successfully")


def handle_mat_zone_update(dat, zone, full_shader):
    """Handle MAT zone (material pixel shader) update."""
    if zone not in ZONE_MAT_CODE_PATHS:
        send_compile_result(dat, zone, False, f"Unknown MAT zone: {zone}")
        return

    code_dat = op(ZONE_MAT_CODE_PATHS[zone])
    glsl_mat = op(ZONE_MAT_PATHS[zone])

    if not code_dat or not glsl_mat:
        send_compile_result(dat, zone, False, f"MAT zone not found: {zone}")
        return

    # Write shader to pixel code DAT
    code_dat.text = full_shader
    glsl_mat.cook(force=True)

    errors = glsl_mat.errors()
    if errors:
        send_compile_result(dat, zone, False, errors)
    else:
        send_compile_result(dat, zone, True)
        print(f"[WS] MAT zone '{zone}' updated successfully")


def send_compile_result(dat, zone, success, error=None):
    result = {"type": "compile_result", "zone": zone, "success": success}
    if error:
        result["error"] = error
    dat.sendText(json.dumps(result))


def handle_mood_update(msg):
    scene_state = op('/project1/scene_state')
    if scene_state:
        update_scene_state(scene_state, 'mood', msg.get('mood', 'mysterious'))
        update_scene_state(scene_state, 'mood_color', msg.get('color', '#8B5CF6'))


def handle_scene_params(params):
    scene_state = op('/project1/scene_state')
    if scene_state:
        for key, value in params.items():
            if value is not None:
                update_scene_state(scene_state, key, str(value))


def handle_aura_update(msg):
    scene_state = op('/project1/scene_state')
    if scene_state:
        update_scene_state(scene_state, 'aura_color', msg.get('color', '#8B5CF6'))
        update_scene_state(scene_state, 'aura_size', str(msg.get('size', 0.3)))


def handle_reveal_effect(msg):
    scene_state = op('/project1/scene_state')
    if scene_state:
        update_scene_state(scene_state, 'reveal_effect', msg.get('effect_type', ''))
        update_scene_state(scene_state, 'reveal_intensity', str(msg.get('intensity', 0.5)))
        update_scene_state(scene_state, 'reveal_time', str(absTime.seconds))


def handle_skeleton_augment(msg):
    overlays = msg.get('overlays', [])
    scene_state = op('/project1/scene_state')
    if scene_state:
        update_scene_state(scene_state, 'skeleton_overlays', json.dumps(overlays))


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

    # Update scene_state for backwards compatibility
    scene_state = op('/project1/scene_state')
    if scene_state:
        update_scene_state(scene_state, 'portrait', str(portrait).lower())
        update_scene_state(scene_state, 'frame_width', str(w))
        update_scene_state(scene_state, 'frame_height', str(h))

    # Update skeleton_glsl_tex resolution and uniform
    glsl = op('/project1/skeleton_glsl_tex')
    if glsl:
        glsl.par.resolutionw = w
        glsl.par.resolutionh = h
        glsl.par.vec0valuex = w
        glsl.par.vec0valuey = h


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


def handle_mentalist_state(msg):
    """Legacy mentalist state handler - now routes to merlin_state."""
    global mentalist_state
    mentalist_state['active'] = msg.get('active', False)
    if 'phase' in msg:
        mentalist_state['phase'] = msg['phase']
    if 'mood' in msg:
        mentalist_state['mood'] = msg['mood']
    if 'colorAccent' in msg:
        mentalist_state['color_accent'] = msg['colorAccent']
    if 'particleBehavior' in msg:
        mentalist_state['particle_behavior'] = msg['particleBehavior']

    # Update force mode in scene_state based on mood
    scene_state = op('/project1/scene_state')
    if scene_state:
        force_mode = MOOD_FORCE_MODE.get(mentalist_state['mood'], 0)
        update_scene_state(scene_state, 'force_mode', str(force_mode))
        print(f"[WS] Mentalist: mood={mentalist_state['mood']} force_mode={force_mode}")


def handle_merlin_state(msg):
    """Handle merlin_state message - session activation and phase."""
    global merlin_state

    merlin_state['active'] = msg.get('active', False)
    if 'phase' in msg:
        merlin_state['phase'] = msg['phase']

    # Update spell_state tableDAT
    table = op('/project1/spell_state')
    if table:
        update_scene_state(table, 'active', '1' if merlin_state['active'] else '0')
        update_scene_state(table, 'phase', merlin_state['phase'])

    print(f"[WS] Merlin: active={merlin_state['active']} phase={merlin_state['phase']}")


def handle_particle_spell_program(msg):
    """Handle particle_spell_program message - full spell program update.

    Updates spell_program state and spell_state tableDAT with zone parameters.
    """
    global merlin_state, spell_program

    mode = msg.get('mode', 'buildup')
    program = msg.get('program', {})

    # Update merlin mode
    merlin_state['mode'] = mode
    merlin_state['mode_float'] = float(SPELL_MODE_MAP.get(mode, -1))
    merlin_state['archetype'] = program.get('archetype', 'breathing_aura_mist')

    # Update spell program state
    spell_program['version'] = program.get('version', '1.0')
    spell_program['spell_id'] = program.get('spellId', '')
    spell_program['intent'] = program.get('intent')
    spell_program['element'] = program.get('element')
    spell_program['archetype'] = program.get('archetype', 'breathing_aura_mist')
    spell_program['energy'] = program.get('energy', 0.2)
    spell_program['energy_floor'] = program.get('energyFloor', 0.1)
    spell_program['energy_ceiling'] = program.get('energyCeiling', 0.55)
    spell_program['casting_origin'] = program.get('castingOrigin')
    spell_program['casting_landmarks'] = program.get('castingLandmarks', [])

    # Palette
    palette = program.get('palette', {})
    spell_program['palette_primary'] = palette.get('primary', '#8B5CF6')
    spell_program['palette_secondary'] = palette.get('secondary', '#A78BFA')
    spell_program['palette_accent'] = palette.get('accent', '#C4B5FD')

    # Extract zone params (flatten nested structure)
    zones = program.get('zones', {})
    _extract_zone_params(zones)

    # Update spell_state tableDAT
    table = op('/project1/spell_state')
    if table:
        update_scene_state(table, 'mode', mode)
        update_scene_state(table, 'mode_float', str(merlin_state['mode_float']))
        update_scene_state(table, 'archetype', spell_program['archetype'])
        update_scene_state(table, 'intent', str(spell_program['intent'] or ''))
        update_scene_state(table, 'element', str(spell_program['element'] or ''))
        update_scene_state(table, 'energy', str(spell_program['energy']))
        update_scene_state(table, 'energy_floor', str(spell_program['energy_floor']))
        update_scene_state(table, 'energy_ceiling', str(spell_program['energy_ceiling']))
        update_scene_state(table, 'casting_origin', str(spell_program['casting_origin'] or ''))
        update_scene_state(table, 'palette_primary', spell_program['palette_primary'])
        update_scene_state(table, 'palette_secondary', spell_program['palette_secondary'])
        update_scene_state(table, 'palette_accent', spell_program['palette_accent'])
        # Zone params
        update_scene_state(table, 'spawn_radius', str(spell_program['spawn_radius']))
        update_scene_state(table, 'spawn_rate', str(spell_program['spawn_rate']))
        update_scene_state(table, 'force_strength', str(spell_program['force_strength']))
        update_scene_state(table, 'force_direction', str(spell_program['force_direction']))
        update_scene_state(table, 'orbit_speed', str(spell_program['orbit_speed']))
        update_scene_state(table, 'turbulence', str(spell_program['turbulence']))
        update_scene_state(table, 'velocity_scale', str(spell_program['velocity_scale']))
        update_scene_state(table, 'damping', str(spell_program['damping']))
        update_scene_state(table, 'base_size', str(spell_program['base_size']))
        update_scene_state(table, 'size_variation', str(spell_program['size_variation']))
        update_scene_state(table, 'saturation', str(spell_program['saturation']))
        update_scene_state(table, 'brightness', str(spell_program['brightness']))
        update_scene_state(table, 'alpha_fade', str(spell_program['alpha_fade']))

    e = spell_program['energy']
    a = spell_program['archetype']
    print(f"[WS] Spell program: mode={mode} archetype={a} energy={e:.2f}")


def _extract_zone_params(zones):
    """Extract zone parameters from nested zones dict into flat spell_program."""
    global spell_program

    # Spawn zone
    spawn = zones.get('spawn', {})
    if 'spawnRadius' in spawn:
        spell_program['spawn_radius'] = spawn['spawnRadius']
    if 'spawnRate' in spawn:
        spell_program['spawn_rate'] = spawn['spawnRate']

    # Force zone
    force = zones.get('force', {})
    if 'forceStrength' in force:
        spell_program['force_strength'] = force['forceStrength']
    if 'forceDirection' in force:
        spell_program['force_direction'] = FORCE_DIRECTION_MAP.get(force['forceDirection'], 0)
    if 'orbitSpeed' in force:
        spell_program['orbit_speed'] = force['orbitSpeed']
    if 'turbulence' in force:
        spell_program['turbulence'] = force['turbulence']

    # Velmod zone
    velmod = zones.get('velmod', {})
    if 'velocityScale' in velmod:
        spell_program['velocity_scale'] = velmod['velocityScale']
    if 'damping' in velmod:
        spell_program['damping'] = velmod['damping']

    # Size zone
    size = zones.get('size', {})
    if 'baseSize' in size:
        spell_program['base_size'] = size['baseSize']
    if 'sizeVariation' in size:
        spell_program['size_variation'] = size['sizeVariation']

    # Color zone
    color = zones.get('color', {})
    if 'saturation' in color:
        spell_program['saturation'] = color['saturation']
    if 'brightness' in color:
        spell_program['brightness'] = color['brightness']
    if 'alphaFade' in color:
        spell_program['alpha_fade'] = color['alphaFade']


def handle_spell_charge(msg):
    """Handle spell_charge message - pre-cast particle tightening."""
    global cast_state, spell_program

    spell_program['casting_origin'] = msg.get('origin')
    spell_program['casting_landmarks'] = msg.get('castingLandmarks', [])
    cast_state['charge_intensity'] = msg.get('intensity', 0.5)

    # Update spell_state tableDAT
    table = op('/project1/spell_state')
    if table:
        update_scene_state(table, 'charge_intensity', str(cast_state['charge_intensity']))
        update_scene_state(table, 'casting_origin', str(spell_program['casting_origin'] or ''))

    o = spell_program['casting_origin']
    i = cast_state['charge_intensity']
    print(f"[WS] Spell charge: origin={o} intensity={i:.2f}")


def handle_spell_cast(msg):
    """Handle spell_cast message - trigger the release envelope."""
    global merlin_state, cast_state, spell_program

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

    # Update program from cast message
    program = msg.get('program', {})
    if program:
        spell_program['archetype'] = program.get('archetype', spell_program['archetype'])
        spell_program['energy'] = program.get('energy', 1.0)

    # Update spell_state tableDAT
    table = op('/project1/spell_state')
    if table:
        update_scene_state(table, 'mode', 'release')
        update_scene_state(table, 'mode_float', '1.0')
        update_scene_state(table, 'cast_trigger', '1.0')
        update_scene_state(table, 'cast_beat', '0.0')
        update_scene_state(table, 'cast_start_time', str(cast_state['start_time']))
        update_scene_state(table, 'ignition_ms', str(cast_state['ignition_ms']))
        update_scene_state(table, 'projection_ms', str(cast_state['projection_ms']))
        update_scene_state(table, 'afterglow_ms', str(cast_state['afterglow_ms']))
        update_scene_state(table, 'peak_intensity', str(cast_state['peak_intensity']))
        update_scene_state(table, 'duration_ms', str(cast_state['duration_ms']))
        update_scene_state(table, 'energy', str(spell_program['energy']))

    o = msg.get('origin', 'unknown')
    d = cast_state['duration_ms']
    print(f"[WS] SPELL CAST! origin={o} duration={d}ms")


def handle_analysis_update(msg):
    """Handle continuous analysis values for mirror/echo visuals.

    Updates both the module-level analysis_state dict and the
    analysis_state tableDAT in TouchDesigner.
    """
    global analysis_state

    # Update module state
    analysis_state['valence'] = msg.get('valence', 0.0)
    analysis_state['arousal'] = msg.get('arousal', 0.0)
    analysis_state['tension'] = msg.get('tension', 0.0)
    analysis_state['openness'] = msg.get('openness', 0.0)
    analysis_state['engagement'] = msg.get('engagement', 0.0)
    analysis_state['primary_emotion'] = msg.get('primary_emotion', 'neutral')
    analysis_state['emotion_index'] = EMOTION_INDEX.get(
        analysis_state['primary_emotion'], 0
    )

    # Update analysis_state tableDAT
    table = op('/project1/analysis_state')
    if table:
        update_scene_state(table, 'valence', str(analysis_state['valence']))
        update_scene_state(table, 'arousal', str(analysis_state['arousal']))
        update_scene_state(table, 'tension', str(analysis_state['tension']))
        update_scene_state(table, 'openness', str(analysis_state['openness']))
        update_scene_state(table, 'engagement', str(analysis_state['engagement']))
        update_scene_state(table, 'primary_emotion', analysis_state['primary_emotion'])
        update_scene_state(table, 'emotion_index', str(analysis_state['emotion_index']))

    v = analysis_state['valence']
    e = analysis_state['primary_emotion']
    print(f"[WS] Analysis: valence={v:.2f} emotion={e}")


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


def handle_request_screenshot(dat):
    """Handle request_screenshot message - capture render and send as base64."""
    import base64

    # Try to get the main render output
    render_top = op('/project1/render1')
    if not render_top:
        # Try alternative names
        render_top = op('/project1/null_out')
        if not render_top:
            render_top = op('/project1/out1')

    if not render_top:
        print("[WS] Screenshot: No render TOP found")
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


def is_pose_detected():
    return tracking_state['pose_detected']

def is_face_detected():
    return tracking_state['face_detected']

def get_frame_dimensions():
    return (tracking_state['frame_width'], tracking_state['frame_height'])

def is_portrait():
    return tracking_state['portrait']

def is_mentalist_active():
    return mentalist_state['active']

def get_mentalist_phase():
    return mentalist_state['phase']

def get_mentalist_mood():
    return mentalist_state['mood']


# ===== Analysis Helpers =====

def get_valence():
    """Get emotional valence (-1 negative to 1 positive)."""
    return analysis_state['valence']

def get_arousal():
    """Get arousal level (0 calm to 1 excited)."""
    return analysis_state['arousal']

def get_tension():
    """Get tension level (0 relaxed to 1 tense)."""
    return analysis_state['tension']

def get_openness():
    """Get openness level (-1 closed to 1 open)."""
    return analysis_state['openness']

def get_engagement():
    """Get engagement level (0 disengaged to 1 engaged)."""
    return analysis_state['engagement']

def get_emotion():
    """Get primary emotion string."""
    return analysis_state['primary_emotion']

def get_emotion_index():
    """Get emotion index for shader lookup (0-5)."""
    return analysis_state['emotion_index']

def get_analysis_vec4_1():
    """Get first analysis vec4: (valence, arousal, tension, openness)."""
    return (
        analysis_state['valence'],
        analysis_state['arousal'],
        analysis_state['tension'],
        analysis_state['openness'],
    )

def get_analysis_vec4_2():
    """Get second analysis vec4: (engagement, emotion_index, 0, 0)."""
    return (
        analysis_state['engagement'],
        float(analysis_state['emotion_index']),
        0.0,
        0.0,
    )

def get_force_mode():
    """Get particle force mode based on current mood (0=orbit, 1=attract, 2=repel, 3=emit)."""
    mood = mentalist_state['mood']
    return MOOD_FORCE_MODE.get(mood, 0)


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

def get_spell_archetype():
    """Get current spell archetype name."""
    return spell_program['archetype']

def get_spell_energy():
    """Get current spell energy (0-1)."""
    return spell_program['energy']

def get_spell_intent():
    """Get spell intent (e.g., 'confidence', 'calm')."""
    return spell_program['intent']

def get_spell_element():
    """Get spell element (e.g., 'fire', 'water')."""
    return spell_program['element']

def get_casting_origin():
    """Get casting origin: 'hands', 'heart', 'eyes', 'whole_body', 'wand'."""
    return spell_program['casting_origin']

def get_casting_landmarks():
    """Get list of MediaPipe landmark indices for casting origin."""
    return spell_program['casting_landmarks']

def get_palette():
    """Get spell palette as (primary, secondary, accent) hex colors."""
    return (
        spell_program['palette_primary'],
        spell_program['palette_secondary'],
        spell_program['palette_accent'],
    )

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

def get_palette_primary_rgb():
    """Get primary palette color as RGB (0-1)."""
    return hex_to_rgb(spell_program['palette_primary'])

def get_palette_secondary_rgb():
    """Get secondary palette color as RGB (0-1)."""
    return hex_to_rgb(spell_program['palette_secondary'])

def get_palette_accent_rgb():
    """Get accent palette color as RGB (0-1)."""
    return hex_to_rgb(spell_program['palette_accent'])

def get_spell_uniforms():
    """Get all spell-related uniforms as a dict for easy binding."""
    return {
        'uSpellEnergy': spell_program['energy'],
        'uSpellMode': merlin_state['mode_float'],
        'uCastTrigger': cast_state['trigger'],
        'uCastBeat': cast_state['beat'],
        'uChargeIntensity': cast_state['charge_intensity'],
        'uForceStrength': spell_program['force_strength'],
        'uForceDirection': float(spell_program['force_direction']),
        'uOrbitSpeed': spell_program['orbit_speed'],
        'uTurbulence': spell_program['turbulence'],
        'uSpawnRadius': spell_program['spawn_radius'],
        'uSpawnRate': spell_program['spawn_rate'],
        'uVelocityScale': spell_program['velocity_scale'],
        'uDamping': spell_program['damping'],
        'uBaseSize': spell_program['base_size'],
        'uSizeVariation': spell_program['size_variation'],
        'uSaturation': spell_program['saturation'],
        'uBrightness': spell_program['brightness'],
        'uAlphaFade': spell_program['alpha_fade'],
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

def update_scene_state(table_dat, key, value):
    for row in range(table_dat.numRows):
        if table_dat[row, 0].val == key:
            table_dat[row, 1] = value
            return
    table_dat.appendRow([key, value])

def onReceiveBinary(dat, rowIndex, contents):
    pass
