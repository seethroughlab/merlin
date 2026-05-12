// Per-particle hash for stable, well-distributed random values. Available
// in every POP/TOP/MAT zone so user snippets can call hash31(id) anywhere.
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

    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // Default size with life fade. 0.08 keeps idle particles big enough
    // to be visible over the webcam (which the additive composite blends
    // them onto) while letting high-energy spells push size up further
    // via the (0.5 + uSpellEnergy) multiplier.
    //   idle (energy=0.2): size ≈ 0.056
    //   buildup (energy=0.5): size ≈ 0.080
    //   release (energy=1.0): size ≈ 0.120
    // NOTE: inline literal instead of `float baseSize = 0.08` so user zone
    // code is free to declare its own baseSize without redefinition error.
    float size = 0.08 * life * (0.5 + uSpellEnergy);

{zone_code}

    xscale[idx] = vec3(size);

    // Pass age/life/id to the billboard vertex shader as instance custom
    // attribute 1. Without this the vertex shader's birth-fadeIn (which
    // reads xpartinfo.x as age) sees age=0 and scales every particle to
    // zero — particles render but become invisible. geo_billboard wires
    // instance1custom{x,y,z} to xpartinfo(0,1,2).
    xpartinfo[idx] = vec3(age, life, id);
}
