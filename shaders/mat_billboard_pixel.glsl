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
//
// Returns continuous float frame position so the caller can blend between
// adjacent frames using fract(). Random mode is handled separately by the
// caller (interpolating between two random frames produces a nonsense blend).

float computeFrameFloat(float driveValue, int frameCount, int playbackMode, float frameDuration) {
    if (frameCount <= 1) return 0.0;
    float fc = float(frameCount);

    if (playbackMode == 0) {              // loop
        return mod(driveValue / frameDuration, fc);
    } else if (playbackMode == 1) {       // once - clamp at last frame; fract collapses to 0 there
        return clamp(driveValue / frameDuration, 0.0, fc - 1.0);
    } else {                              // pingpong (mode 2): tent wave 0 -> N-1 -> 0
        float period = 2.0 * (fc - 1.0);
        if (period <= 0.0) return 0.0;
        float t = mod(driveValue / frameDuration, period);
        return (fc - 1.0) - abs(t - (fc - 1.0));
    }
}

vec2 atlasUVForFrame(int frame, int cols, int rows, vec2 baseUV) {
    float cellW = 1.0 / float(cols);
    float cellH = 1.0 / float(rows);
    int col = frame % cols;
    int row = frame / cols;
    return vec2(baseUV.x * cellW + float(col) * cellW,
                baseUV.y * cellH + float(row) * cellH);
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

    // Sample sprite - interpolated between adjacent frames unless random mode.
    // Luminance is linear in RGB, so applying the alpha derivation below to the
    // pre-mixed sprite is equivalent to per-frame alpha blended together.
    vec4 sprite;
    if (playbackMode == 3) {
        // Random mode: discrete per-particle frame, no blending
        int frame = int(mod(vId * 7919.0, float(frameCount)));
        frame = clamp(frame, 0, frameCount - 1);
        vec2 uv = atlasUVForFrame(frame, atlasCols, atlasRows, vUV);
        sprite = texture(sSpriteMap, uv);
    } else {
        float frameFloat = computeFrameFloat(driveValue, frameCount, playbackMode, frameDuration);
        int frame0 = int(frameFloat) % frameCount;
        int frame1 = (frame0 + 1) % frameCount;
        float blend = fract(frameFloat);
        vec2 uv0 = atlasUVForFrame(frame0, atlasCols, atlasRows, vUV);
        vec2 uv1 = atlasUVForFrame(frame1, atlasCols, atlasRows, vUV);
        sprite = mix(texture(sSpriteMap, uv0), texture(sSpriteMap, uv1), blend);
    }

    // Base color from particle color * sprite
    vec3 albedo = vColor.rgb * sprite.rgb;

    // Derive alpha from sprite luminance instead of sprite.a. Gemini's
    // image-gen returns JPEG (no alpha channel) with the prompt-required
    // "fades to pure black at edges" pattern, so luminance == intended
    // alpha. For PNG sprites with a proper alpha channel + black bg, the
    // luminance also fades with the alpha so this is a no-op there. We
    // multiply by sprite.a too so true-transparent PNG pixels stay clear.
    float spriteIntensity = dot(sprite.rgb, vec3(0.299, 0.587, 0.114));
    float alpha = vColor.a * max(sprite.a * spriteIntensity, spriteIntensity);

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
