// Force Field - particle forces driven by analysis values
// Output: PartForce
// Custom behavior can modify: force
//
// Available uniforms:
//   uTime, uDeltaTime
//   uAnalysis1: (valence, arousal, tension, openness)
//   uAnalysis2: (engagement, emotion_index, 0, 0)
//   uBodyCenter: body center position
//   uForceMode: 0=orbit, 1=attract, 2=repel, 3=emit

uniform float uTime;
uniform float uDeltaTime;
uniform vec4 uAnalysis1;
uniform vec4 uAnalysis2;
uniform vec3 uBodyCenter;
uniform int uForceMode;

#define uValence uAnalysis1.x
#define uArousal uAnalysis1.y
#define uTension uAnalysis1.z
#define uOpenness uAnalysis1.w
#define uEngagement uAnalysis2.x
#define uEmotionIndex int(uAnalysis2.y)

void main() {
    uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    float id = float(TDInPoint_PartId());
    vec3 pos = TDInPoint_P();
    vec3 vel = TDInPoint_PartVel();
    float age = TDInPoint_PartAge();
    float lifeSpan = TDInPoint_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));
    vec3 force = TDInPoint_PartForce();

    // Base forces from analysis
    force.y += uValence * 0.1;  // Valence: vertical drift

    // Arousal turbulence
    vec3 noisePos = pos * 3.0 + uTime;
    force += sin(noisePos) * uArousal * 0.1;

    // Tension: inward pressure
    vec3 toCenter = normalize(uBodyCenter - pos);
    float distToBody = length(uBodyCenter - pos);
    force += toCenter * uTension * 0.2 * smoothstep(0.5, 0.0, distToBody);

    // Openness: expansion
    force += -toCenter * uOpenness * 0.15;

    // === custom behavior ===
    {zone_code}
    // === end ===

    oTDPoint_PartForce[idx] = force;
}
