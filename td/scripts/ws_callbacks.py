"""
WebSocket callbacks for Parlor <-> TouchDesigner communication.

Expanded POP system for mirror/echo AR visuals.
"""
import json
import os

# Base path for shader templates (relative to TD project)
SHADER_TEMPLATE_DIR = 'shaders'

# Zone to template file mapping
ZONE_TEMPLATES = {
    'force_field': 'force.glsl',
    'spawn_behavior': 'spawn.glsl',
    'color_over_life': 'color.glsl',
    'size_over_life': 'size.glsl',
    'velocity_modifier': 'velmod.glsl',
}

# Zone to glslPOP node mapping
ZONE_PATHS = {
    'force_field': '/project1/glsl_force1',
    'spawn_behavior': '/project1/glsl_spawn',
    'color_over_life': '/project1/glsl_color1',
    'size_over_life': '/project1/glsl_size',
    'velocity_modifier': '/project1/glsl_velmod',
}

# Zone to compute textDAT mapping
ZONE_COMPUTE_PATHS = {
    'force_field': '/project1/glsl_force1_compute',
    'spawn_behavior': '/project1/glsl_spawn_compute',
    'color_over_life': '/project1/glsl_color1_compute',
    'size_over_life': '/project1/glsl_size_compute',
    'velocity_modifier': '/project1/glsl_velmod_compute',
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
