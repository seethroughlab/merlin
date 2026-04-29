// Color Over Life - emotion-based palettes
// Output: Cd (custom attribute, vec4)
// Custom behavior can modify: color

uniform float uTime;
uniform float uDeltaTime;
uniform vec4 uAnalysis1;
uniform vec4 uAnalysis2;

#define uValence uAnalysis1.x
#define uArousal uAnalysis1.y
#define uTension uAnalysis1.z
#define uOpenness uAnalysis1.w
#define uEngagement uAnalysis2.x
#define uEmotionIndex int(uAnalysis2.y)

// Emotion palettes: 0=neutral, 1=joy, 2=fear, 3=anger, 4=sadness, 5=surprise
const vec3 PAL_NEUTRAL[3] = vec3[](vec3(0.55, 0.36, 0.96), vec3(0.4, 0.4, 0.9), vec3(0.6, 0.5, 0.8));
const vec3 PAL_JOY[3] = vec3[](vec3(1.0, 0.9, 0.4), vec3(1.0, 0.7, 0.3), vec3(1.0, 1.0, 0.9));
const vec3 PAL_FEAR[3] = vec3[](vec3(0.3, 0.5, 0.9), vec3(0.5, 0.6, 0.8), vec3(0.9, 0.95, 1.0));
const vec3 PAL_ANGER[3] = vec3[](vec3(0.9, 0.2, 0.1), vec3(1.0, 0.4, 0.1), vec3(1.0, 0.8, 0.3));
const vec3 PAL_SAD[3] = vec3[](vec3(0.2, 0.3, 0.6), vec3(0.3, 0.4, 0.7), vec3(0.4, 0.4, 0.5));
const vec3 PAL_SURPRISE[3] = vec3[](vec3(1.0, 1.0, 0.8), vec3(0.9, 0.8, 0.5), vec3(0.7, 0.6, 0.8));

vec3 getEmotionColor(int emo, float t) {
    vec3 c0, c1, c2;
    if (emo == 1) { c0 = PAL_JOY[0]; c1 = PAL_JOY[1]; c2 = PAL_JOY[2]; }
    else if (emo == 2) { c0 = PAL_FEAR[0]; c1 = PAL_FEAR[1]; c2 = PAL_FEAR[2]; }
    else if (emo == 3) { c0 = PAL_ANGER[0]; c1 = PAL_ANGER[1]; c2 = PAL_ANGER[2]; }
    else if (emo == 4) { c0 = PAL_SAD[0]; c1 = PAL_SAD[1]; c2 = PAL_SAD[2]; }
    else if (emo == 5) { c0 = PAL_SURPRISE[0]; c1 = PAL_SURPRISE[1]; c2 = PAL_SURPRISE[2]; }
    else { c0 = PAL_NEUTRAL[0]; c1 = PAL_NEUTRAL[1]; c2 = PAL_NEUTRAL[2]; }

    if (t < 0.5) return mix(c0, c1, t * 2.0);
    return mix(c1, c2, (t - 0.5) * 2.0);
}

void main() {
    uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    float id = float(TDInPoint_PartId());
    float age = TDInPoint_PartAge();
    float lifeSpan = TDInPoint_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // Base color from emotion palette
    vec3 rgb = getEmotionColor(uEmotionIndex, life);

    // Valence shifts color temperature
    vec3 warmShift = vec3(0.1, 0.05, -0.1);
    vec3 coolShift = vec3(-0.1, 0.0, 0.15);
    rgb += mix(coolShift, warmShift, uValence * 0.5 + 0.5) * 0.3;

    // Arousal affects brightness
    rgb *= 0.8 + uArousal * 0.4;

    vec4 color = vec4(rgb, life);

    // === custom behavior ===
    {zone_code}
    // === end ===

    oTDPoint_Cd[idx] = color;
}
