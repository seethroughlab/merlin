// IQ-style multiplicative hash. fract(sin(...)) collapses near zero and
// aliases for small integer inputs; this stays well-distributed across
// sequential particle ids.
vec3 hash31(float p) {
    vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}

void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    // Persistent particle id for stable per-particle effects in zone code.
    float id = float(TDIn_PartId());

    vec3 vel = TDIn_PartVel();
    vec3 pos = TDIn_P();
    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // Default: simple drag
    vel *= 0.98;

    // Per-particle drift keyed off the persistent PartId, so neighbouring
    // particles fan out instead of stacking pixel-for-pixel into thin
    // trails. Small enough to accumulate gently across a 4s lifespan
    // rather than launch particles off-screen. Scaled by spell energy so
    // it's most visible at idle and gives way to spell zone code.
    // NOTE: inlined (no `vec3 idDrift = ...` local) so user zone code is
    // free to declare its own idDrift without redefinition error.
    vel += (hash31(id) - 0.5) * 0.001 * (0.5 + 0.5 * uSpellEnergy);

{zone_code}

    PartVel[idx] = vel;
}
