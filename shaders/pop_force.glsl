void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    vec3 pos = TDIn_P();
    vec3 vel = TDIn_PartVel();
    float age = TDIn_PartAge();
    float lifeSpan = TDIn_PartLifeSpan();
    float life = 1.0 - (age / max(lifeSpan, 0.001));
    vec3 force = TDIn_PartForce();

    // Default behavior: gentle orbit with center attraction
    vec2 toCenter = vec2(0.5, 0.5) - pos.xy;
    float dist = length(toCenter);

    // Gentle orbit
    force.x += -toCenter.y * 0.03;
    force.y += toCenter.x * 0.03;

    // Center attraction
    float pullStrength = smoothstep(0.15, 0.4, dist) * 0.05;
    force.xy += normalize(toCenter) * pullStrength;

    // Gentle upward drift
    force.y += 0.005;

    // Scale by spell energy
    force *= (0.5 + uSpellEnergy);

    // {zone_code}

    PartForce[idx] = force;
}
