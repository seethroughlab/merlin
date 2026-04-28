"""
WebSocket callbacks for Parlor <-> TouchDesigner communication.
Reference this file from a WebSocket DAT's callbacks parameter.

This module handles all incoming messages from Parlor and maintains
scene state that other TD operators can access.
"""
import json

# Scene state storage - accessed by other operators via mod.ws_callbacks
scene_state = {
    'mood': 'mysterious',
    'mood_color': '#8B5CF6',
    'particle_intensity': 'subtle',
    'particle_behavior': 'calm',
    'particle_color': '#8B5CF6',
    'aura_color': '#8B5CF6',
    'aura_size': 0.3,
    'background_mood': 'mysterious',
}

# Pending reveal effects (consumed by particle system)
pending_reveals = []

# Skeleton overlays from Gemini
skeleton_overlays = []


def onConnect(dat):
    """Called when WebSocket connects to Parlor."""
    print(f"[WS] Connected to Parlor")
    # Send ready message with capabilities
    ready_msg = json.dumps({
        "type": "td_ready",
        "capabilities": {
            "hasParticles": True,
            "hasAura": True,
            "hasSkeletonOverlay": True,
            "availableZones": ["spawn", "force", "color"]
        }
    })
    dat.sendText(ready_msg)


def onDisconnect(dat):
    """Called when WebSocket disconnects."""
    print(f"[WS] Disconnected from Parlor")


def onReceiveText(dat, data, bytes):
    """Handle incoming JSON messages from Parlor."""
    global scene_state, pending_reveals, skeleton_overlays

    try:
        msg = json.loads(data)
        msg_type = msg.get('type', '')

        if msg_type == 'ping':
            dat.sendText('{"type":"pong"}')

        elif msg_type == 'mood_update':
            scene_state['mood'] = msg.get('mood', 'mysterious')
            if msg.get('color'):
                scene_state['mood_color'] = msg['color']
            print(f"[WS] Mood: {scene_state['mood']}")
            _update_scene_state_table()

        elif msg_type == 'scene_params':
            params = msg.get('params', {})
            for key in ['particle_intensity', 'particle_behavior', 'particle_color',
                       'aura_color', 'aura_size', 'background_mood']:
                if key in params and params[key] is not None:
                    scene_state[key] = params[key]
            print(f"[WS] Scene params updated")
            _update_scene_state_table()

        elif msg_type == 'reveal_effect':
            pending_reveals.append({
                'effect_type': msg.get('effect_type', 'burst'),
                'intensity': msg.get('intensity', 0.5),
                'duration': msg.get('duration', 2),
                'landmark': msg.get('landmark'),
                'timestamp': absTime.seconds
            })
            print(f"[WS] Reveal: {msg.get('effect_type')}")

        elif msg_type == 'aura_update':
            scene_state['aura_color'] = msg.get('color', '#8B5CF6')
            scene_state['aura_size'] = msg.get('size', 0.3)
            print(f"[WS] Aura: {scene_state['aura_color']}")
            _update_scene_state_table()

        elif msg_type == 'skeleton_augment':
            skeleton_overlays = msg.get('overlays', [])
            print(f"[WS] Overlays: {len(skeleton_overlays)}")

    except Exception as e:
        print(f"[WS] Error: {e}")


def onReceiveBinary(dat, data):
    """Handle binary data (not used)."""
    pass


def _update_scene_state_table():
    """Update the scene_state tableDAT with current values."""
    try:
        table = op('scene_state')
        if table:
            table.clear()
            table.appendRow(['key', 'value'])
            for key, value in scene_state.items():
                table.appendRow([key, str(value)])
    except:
        pass  # Table may not exist yet


def _hex_to_rgb(hex_color):
    """Convert hex color to RGB tuple (0-1 range)."""
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 6:
        r = int(hex_color[0:2], 16) / 255.0
        g = int(hex_color[2:4], 16) / 255.0
        b = int(hex_color[4:6], 16) / 255.0
        return (r, g, b)
    return (1, 1, 1)


# ===== Public API for other operators =====

def get_scene_state():
    """Get a copy of the current scene state."""
    return scene_state.copy()


def get_mood():
    """Get current mood string."""
    return scene_state['mood']


def get_mood_color_rgb():
    """Get mood color as RGB tuple (0-1 range)."""
    return _hex_to_rgb(scene_state['mood_color'])


def get_aura_color_rgb():
    """Get aura color as RGB tuple (0-1 range)."""
    return _hex_to_rgb(scene_state['aura_color'])


def get_aura_size():
    """Get aura size (0-1)."""
    return scene_state['aura_size']


def get_particle_color_rgb():
    """Get particle color as RGB tuple (0-1 range)."""
    return _hex_to_rgb(scene_state['particle_color'])


def get_particle_intensity():
    """Get particle intensity string."""
    return scene_state['particle_intensity']


def get_particle_behavior():
    """Get particle behavior string."""
    return scene_state['particle_behavior']


def get_pending_reveals():
    """Get and clean up pending reveal effects."""
    global pending_reveals
    reveals = pending_reveals.copy()
    # Clear reveals older than 5 seconds
    now = absTime.seconds
    pending_reveals = [r for r in pending_reveals if now - r['timestamp'] < 5]
    return reveals


def pop_reveal():
    """Pop the oldest pending reveal, or None if empty."""
    global pending_reveals
    if pending_reveals:
        return pending_reveals.pop(0)
    return None


def get_skeleton_overlays():
    """Get current skeleton overlays."""
    return skeleton_overlays.copy()


def clear_skeleton_overlays():
    """Clear all skeleton overlays."""
    global skeleton_overlays
    skeleton_overlays = []
