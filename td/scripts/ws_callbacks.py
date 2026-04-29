"""
WebSocket callbacks for Parlor <-> TouchDesigner communication.
"""
import json

ZONE_PATHS = {
    'force_field': '/project1/particles/glsl_force',
    'color_over_life': '/project1/particles/glsl_color',
}

ZONE_COMPUTE_PATHS = {
    'force_field': '/project1/particles/glsl_force_compute',
    'color_over_life': '/project1/particles/glsl_color_compute',
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


def onConnect(dat):
    print(f"[WS] Connected to Parlor")
    ready_msg = json.dumps({
        "type": "td_ready",
        "capabilities": {
            "hasParticles": True,
            "hasAura": True,
            "hasSkeletonOverlay": True,
            "availableZones": list(ZONE_PATHS.keys())
        }
    })
    dat.sendText(ready_msg)


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

    except Exception as e:
        print(f"[WS] Error: {e}")


def handle_zone_update(dat, msg):
    zone = msg.get('zone', '')
    glsl_code = msg.get('glsl_code', '')

    if zone not in ZONE_COMPUTE_PATHS:
        send_compile_result(dat, zone, False, f"Unknown zone: {zone}")
        return

    compute_dat = op(ZONE_COMPUTE_PATHS[zone])
    glsl_pop = op(ZONE_PATHS[zone])

    if not compute_dat or not glsl_pop:
        send_compile_result(dat, zone, False, f"Zone not found: {zone}")
        return

    compute_dat.text = glsl_code
    glsl_pop.cook(force=True)

    errors = glsl_pop.errors()
    if errors:
        send_compile_result(dat, zone, False, errors)
    else:
        send_compile_result(dat, zone, True)


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

def update_scene_state(table_dat, key, value):
    for row in range(table_dat.numRows):
        if table_dat[row, 0].val == key:
            table_dat[row, 1] = value
            return
    table_dat.appendRow([key, value])

def onReceiveBinary(dat, rowIndex, contents):
    pass
