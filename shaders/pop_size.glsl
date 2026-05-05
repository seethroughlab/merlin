void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // Default size with life fade
    float size = 0.015 * life;
    size *= (0.8 + uSpellEnergy * 0.4);

    // {zone_code}

    xscale[idx] = vec3(size);
}
