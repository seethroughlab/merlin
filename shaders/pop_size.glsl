void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    // Persistent particle id for stable per-particle effects in zone code.
    float id = float(TDIn_PartId());

    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // Default size with life fade. baseSize=0.08 keeps idle particles
    // big enough to be visible over the webcam (which the additive
    // composite blends them onto) while letting high-energy spells push
    // size up further via the (0.5 + uSpellEnergy) multiplier.
    //   idle (energy=0.2): size ≈ 0.056
    //   buildup (energy=0.5): size ≈ 0.080
    //   release (energy=1.0): size ≈ 0.120
    float baseSize = 0.08;
    float size = baseSize * life;
    size *= (0.5 + uSpellEnergy);

    // {zone_code}

    xscale[idx] = vec3(size);

    // Pass age/life/id to the billboard vertex shader as instance custom
    // attribute 1. Without this the vertex shader's birth-fadeIn (which
    // reads xpartinfo.x as age) sees age=0 and scales every particle to
    // zero — particles render but become invisible. geo_billboard wires
    // instance1custom{x,y,z} to xpartinfo(0,1,2).
    xpartinfo[idx] = vec3(age, life, id);
}
