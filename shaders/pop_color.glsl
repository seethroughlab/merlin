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

    // Default purple with life fade
    vec4 color = vec4(0.6, 0.4, 0.9, life * 0.7);
    color.rgb *= (0.6 + uSpellEnergy * 0.6);

{zone_code}

    xcolor[idx] = color;
}
