void main() {
    const uint id = TDIndex();
    if (id >= TDNumElements()) return;

    vec3 pos = TDIn_P();
    vec3 vel = TDIn_PartVel();
    float age = TDIn_PartAge();

    if (age < uDeltaTime * 1.5) {
        // Particle just born - initialize position and velocity
        float seed = fract(sin(fract(float(id) * 0.00123456) * 6.283) * 43758.5453);
        float seed2 = fract(sin(float(id) * 78.233) * 43758.5453);
        float seed3 = fract(sin(float(id) * 43.758) * 12345.6789);

        // Default: spawn in sphere with outward velocity
        float theta = seed * 6.283;
        float phi = seed2 * 3.14159 - 1.57;
        float radius = 0.1 + seed3 * 0.15;

        pos.x = cos(theta) * cos(phi) * radius;
        pos.y = sin(phi) * radius;
        pos.z = sin(theta) * cos(phi) * radius;

        vel = vec3((seed - 0.5) * 0.1, 0.2 + seed2 * 0.1, (seed3 - 0.5) * 0.1);

        // {zone_code}
    }

    P[id] = pos;
    PartVel[id] = vel;
}
