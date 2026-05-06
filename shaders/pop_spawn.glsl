// IQ-style multiplicative hash. fract(sin(...)) collapses near zero and
// aliases for small integer inputs, producing emergent attractor clusters
// instead of uniform randomness — that bug was the source of the "8
// fountains" baseline visual.
vec3 hash31(float p) {
    vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}

void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    // Persistent particle id — preferred over TDIndex for stable
    // per-particle randomness across slot recycling.
    float id = float(TDIn_PartId());

    vec3 pos = TDIn_P();
    vec3 vel = TDIn_PartVel();
    float age = TDIn_PartAge();

    if (age < uDeltaTime * 1.5) {
        // Particle just born. Leave `pos` alone — particle1 already
        // chose a random input point from the pointgenerator's spawn
        // pool (verified per-particle distinct via rndinputpts=True).
        // Only initialise velocity, with an outward radial component
        // plus a small id-keyed perturbation so neighbouring particles
        // diverge instead of stacking.
        vec3 r = hash31(id);
        vec3 outward = normalize(pos + vec3(1e-5)) * (0.05 + r.x * 0.05);
        vec3 jitter = (r - 0.5) * 0.05;
        vel = outward + jitter;

        // {zone_code}
    }

    P[idx] = pos;
    PartVel[idx] = vel;
}
