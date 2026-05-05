void main() {
    const uint idx = TDIndex();
    if (idx >= TDNumElements()) return;

    vec3 vel = TDIn_PartVel();
    vec3 pos = TDIn_P();
    float age = TDIn_PartAge();

    // Default: simple drag
    vel *= 0.98;

    // {zone_code}

    PartVel[idx] = vel;
}
