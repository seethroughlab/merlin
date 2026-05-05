// Billboard Particle Vertex Shader
// Renders camera-facing quads using sprite textures
// Instance colors from POP xcolor attribute via TDInstanceColor()
// Custom instance attributes: vel.xyz (attrib0), age+life+id (attrib1)

// Time uniform from TD (absTime.seconds)
uniform float uTime;

// Spell uniforms
uniform float uSpellEnergy;
uniform float uSpellMode;

out vec4 vColor;
out vec2 vUV;
out vec3 vVelocity;
out float vAge;
out float vLife;
out float vId;
out float vSpellEnergy;
out float vSpellMode;

void main()
{
    vColor = TDInstanceColor(vec4(1.0));
    vSpellEnergy = uSpellEnergy;
    vSpellMode = uSpellMode;

    // Extract particle attributes using TD function calls (NOT input variables)
    // attrib0: PartVel.x, PartVel.y, PartVel.z, (unused)
    // attrib1: xpartinfo - age, life, id, (unused)
    vec4 attrib0 = TDInstanceCustomAttrib0();
    vec4 attrib1 = TDInstanceCustomAttrib1();

    vec3 vel = attrib0.xyz;
    float age = attrib1.x;    // xpartinfo.x (particle age in seconds)
    float life = attrib1.y;   // xpartinfo.y (1.0 at birth -> 0.0 at death)
    float id = attrib1.z;     // xpartinfo.z (unique particle id)

    // Pass to pixel shader
    vVelocity = vel;
    vAge = age;
    vLife = life;
    vId = id;

    // Local quad position (-0.5 to 0.5 range expected)
    vec3 localPos = TDPos();

    // Pass UV coordinates (quad UVs: 0,0 to 1,1)
    vUV = localPos.xy + 0.5;

    // Get camera vectors from view matrix inverse (camera-to-world)
    // camInverse transforms from camera space to world space
    // Column 0 = camera right vector, Column 1 = camera up vector
    int camIdx = TDCameraIndex();
    vec3 camRight = uTDMats[camIdx].camInverse[0].xyz;
    vec3 camUp = uTDMats[camIdx].camInverse[1].xyz;

    // Get instance transform (position and scale from POP)
    vec4 instancePos = TDDeform(vec4(0.0, 0.0, 0.0, 1.0));
    vec3 instanceScale = TDInstanceScale();

    // Scale-in effect: particles grow from 0 over first 0.15 seconds
    // This prevents particles from "popping" into existence
    float birthDuration = 0.15;
    float scaleIn = smoothstep(0.0, birthDuration, age);
    float finalScale = instanceScale.x * scaleIn;

    // Billboard: orient quad to face camera, apply instance scale with birth animation
    // localPos.xy is the quad vertex offset (-0.5 to 0.5)
    vec3 worldOffset = (localPos.x * camRight + localPos.y * camUp) * finalScale;
    vec4 worldPos = vec4(instancePos.xyz + worldOffset, 1.0);

    gl_Position = TDWorldToProj(worldPos);
#ifndef TD_PICKING_ACTIVE
#else
    TDWritePickingValues();
#endif
}
