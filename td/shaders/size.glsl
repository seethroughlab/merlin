// Size Over Life - particle scale based on analysis
// Output: pscale (custom attribute, float)
// Custom behavior can modify: size

uniform float uTime;
uniform float uDeltaTime;
uniform vec4 uAnalysis1;
uniform vec4 uAnalysis2;

#define uValence uAnalysis1.x
#define uArousal uAnalysis1.y
#define uTension uAnalysis1.z
#define uOpenness uAnalysis1.w
#define uEngagement uAnalysis2.x

void main() {
    uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    float id = float(TDInPoint_PartId());
    float age = TDInPoint_PartAge();
    float lifeSpan = TDInPoint_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // Base size with life falloff
    float size = 0.05 * life;

    // Arousal adds size variation
    size *= 1.0 + uArousal * 0.5;

    // Tension compresses size
    size *= 1.0 - uTension * 0.3;

    size = max(size, 0.001);

    // === custom behavior ===
    {zone_code}
    // === end ===

    oTDPoint_pscale[idx] = size;
}
