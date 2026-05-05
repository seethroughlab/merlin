// Billboard Particle Pixel Shader
// Samples sprite texture with flipbook animation and applies particle color
// Instance colors and particle attributes passed from vertex shader

in vec4 vColor;
in vec2 vUV;
in vec3 vVelocity;
in float vAge;
in float vLife;
in float vId;
in float vSpellEnergy;
in float vSpellMode;

uniform sampler2D sSpriteMap;
uniform float uTime;

// Flipbook config via vec uniforms (set by TD bridge):
// uFlipbook1: (atlasCols, atlasRows, frameCount, playbackMode)
// uFlipbook2: (frameDuration, driveSource, renderMode, 0)
uniform vec4 uFlipbook1;
uniform vec4 uFlipbook2;

out vec4 oFragColor;

// Flipbook frame index calculation
// Playback modes: 0=loop, 1=once, 2=pingpong, 3=random
// Drive sources: 0=age, 1=life, 2=velocity, 3=id, 4=time

int computeFrameIndex(float driveValue, int frameCount, int playbackMode, float frameDuration, float particleId) {
    if (frameCount <= 1) return 0;

    int frame;
    if (playbackMode == 0) {  // loop
        frame = int(mod(driveValue / frameDuration, float(frameCount)));
    } else if (playbackMode == 1) {  // once
        frame = min(int(driveValue / frameDuration), frameCount - 1);
    } else if (playbackMode == 2) {  // pingpong
        int totalFrames = 2 * frameCount - 2;
        if (totalFrames <= 0) return 0;
        int cycle = int(mod(driveValue / frameDuration, float(totalFrames)));
        frame = cycle < frameCount ? cycle : totalFrames - cycle;
    } else {  // random (using particle id as seed)
        frame = int(mod(particleId * 7919.0, float(frameCount)));
    }
    return clamp(frame, 0, frameCount - 1);
}

void main()
{
    // Flipbook atlas parameters from vec uniforms
    int atlasCols = max(1, int(uFlipbook1.x));
    int atlasRows = max(1, int(uFlipbook1.y));
    int frameCount = max(1, int(uFlipbook1.z));
    int playbackMode = int(uFlipbook1.w);
    float frameDuration = max(0.001, uFlipbook2.x);
    int driveSource = int(uFlipbook2.y);

    // Calculate drive value based on source
    float driveValue;
    if (driveSource == 0) driveValue = vAge;
    else if (driveSource == 1) driveValue = vLife > 0.0 ? vAge / vLife : 0.0;
    else if (driveSource == 2) driveValue = length(vVelocity);
    else if (driveSource == 3) driveValue = vId;
    else driveValue = uTime;

    // Calculate frame index (per-particle)
    int frameIndex = computeFrameIndex(driveValue, frameCount, playbackMode, frameDuration, vId);

    // Atlas UV calculation
    vec2 atlasUV = vUV;
    if (atlasCols > 1 || atlasRows > 1) {
        float cellW = 1.0 / float(atlasCols);
        float cellH = 1.0 / float(atlasRows);
        int col = frameIndex % atlasCols;
        int row = frameIndex / atlasCols;
        atlasUV = vec2(
            vUV.x * cellW + float(col) * cellW,
            vUV.y * cellH + float(row) * cellH
        );
    }

    // Sample sprite texture with atlas UV
    vec4 sprite = texture(sSpriteMap, atlasUV);

    // Base color from particle color * sprite
    vec3 albedo = vColor.rgb * sprite.rgb;
    float alpha = vColor.a * sprite.a;

    // Fade-in effect: particles fade in over first 0.15 seconds
    // This complements the scale-in from the vertex shader for smooth births
    float birthDuration = 0.15;
    float fadeIn = smoothstep(0.0, birthDuration, vAge);
    alpha *= fadeIn;

    // Particle attributes available for zone code
    vec3 vel = vVelocity;
    float age = vAge;
    float life = vLife;
    float id = vId;
    float energy = vSpellEnergy;
    float mode = vSpellMode;

    // Material zone output variables
    // brightness (float): overall brightness multiplier (default 1.0)
    // saturation (float): color saturation, 0=grayscale, 1=full color (default 1.0)
    // hueShift (float): hue rotation in radians (default 0.0)
    float brightness = 1.0;
    float saturation = 1.0;
    float hueShift = 0.0;

    // {zone_code}

    // Apply brightness
    vec3 color = albedo * brightness;

    // Apply saturation
    float luminance = dot(color, vec3(0.299, 0.587, 0.114));
    color = mix(vec3(luminance), color, saturation);

    // Apply hue shift (if non-zero)
    if (abs(hueShift) > 0.001) {
        // Hue rotation matrix
        float cosH = cos(hueShift);
        float sinH = sin(hueShift);
        mat3 hueMatrix = mat3(
            0.299 + 0.701*cosH + 0.168*sinH,
            0.587 - 0.587*cosH + 0.330*sinH,
            0.114 - 0.114*cosH - 0.497*sinH,
            0.299 - 0.299*cosH - 0.328*sinH,
            0.587 + 0.413*cosH + 0.035*sinH,
            0.114 - 0.114*cosH + 0.292*sinH,
            0.299 - 0.300*cosH + 1.250*sinH,
            0.587 - 0.588*cosH - 1.050*sinH,
            0.114 + 0.886*cosH - 0.203*sinH
        );
        color = hueMatrix * color;
    }

    // Discard fully transparent pixels
    if (alpha < 0.01) discard;

    oFragColor = vec4(color, alpha);
}
