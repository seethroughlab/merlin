void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));

    // Default purple with life fade
    vec4 color = vec4(0.6, 0.4, 0.9, life * 0.7);
    color.rgb *= (0.6 + uSpellEnergy * 0.6);

    // {zone_code}

    xcolor[idx] = color;
}
