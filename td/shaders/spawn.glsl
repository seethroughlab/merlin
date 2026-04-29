// Spawn Behavior - emission patterns based on openness/arousal
// Output: P, PartVel
// Custom behavior can modify: pos, vel, seed

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

    vec3 pos = TDInPoint_P();
    vec3 vel = TDInPoint_PartVel();
    float age = TDInPoint_PartAge();

    // Only modify newly spawned particles
    if (age < uDeltaTime * 1.5) {
        // Stable per-particle random seed
        float seed = fract(sin(fract(float(idx) * 0.00123456) * 6.283) * 43758.5453);

        // === custom behavior ===
        {zone_code}
        // === end ===
    }

    oTDPoint_P[idx] = pos;
    oTDPoint_PartVel[idx] = vel;
}
