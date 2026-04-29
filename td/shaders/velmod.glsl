// Velocity Modifier - speed and damping based on analysis
// Output: PartVel
// Custom behavior can modify: vel

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
    vec3 vel = TDInPoint_PartVel();
    vec3 pos = TDInPoint_P();
    float age = TDInPoint_PartAge();
    float lifeSpan = TDInPoint_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // Arousal speeds things up
    float speedMult = 0.5 + uArousal * 1.5;
    vel *= speedMult;

    // Tension adds damping
    float damping = 1.0 - uTension * 0.3;
    vel *= damping;

    // === custom behavior ===
    {zone_code}
    // === end ===

    oTDPoint_PartVel[idx] = vel;
}
