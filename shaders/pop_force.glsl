// Per-particle hash for stable, well-distributed random values. Available
// in every POP/TOP/MAT zone so user snippets can call hash31(id) anywhere
// without worrying about which template declares it.
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

    vec3 pos = TDIn_P();
    vec3 vel = TDIn_PartVel();
    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));
    vec3 force = TDIn_PartForce();

    // No opinionated default motion. Idle baseline = zero force; particles
    // inherit emission velocity from glsl_spawn, get gradually slowed by
    // drag in glsl_velmod, and fan out via the per-id drift there. Spell
    // motion comes entirely from the zone snippet below. Aligns with
    // vibe-agent's minimal-template philosophy.

{zone_code}

    // Energy scaling preserved so zone code that sets force.xyz directly
    // still scales with spell energy at the very end.
    force *= (0.5 + uSpellEnergy);

    PartForce[idx] = force;
}
