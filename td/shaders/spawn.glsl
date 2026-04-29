// Spawn Behavior - emission patterns based on openness/arousal
// Output: P, PartVel
// Custom behavior can modify: pos, vel, seed

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
