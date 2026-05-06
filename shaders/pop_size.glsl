void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    // Persistent particle id for stable per-particle effects in zone code.
    float id = float(TDIn_PartId());

    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // Default size with life fade. baseSize matches the vibe-agent
    // reference (0.05) — large enough that a single particle reads as a
    // visible disc against the camera at the project's typical 0.4–0.7
    // unit camera distance, instead of a sub-pixel smudge.
    float baseSize = 0.05;
    float size = baseSize * life;
    size *= (0.8 + uSpellEnergy * 0.4);

    // {zone_code}

    xscale[idx] = vec3(size);

    // Pass age/life/id to the billboard vertex shader as instance custom
    // attribute 1. Without this the vertex shader's birth-fadeIn (which
    // reads xpartinfo.x as age) sees age=0 and scales every particle to
    // zero — particles render but become invisible. geo_billboard wires
    // instance1custom{x,y,z} to xpartinfo(0,1,2).
    xpartinfo[idx] = vec3(age, life, id);
}
