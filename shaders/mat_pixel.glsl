// Material pixel shader template for GLSL MAT
// This template allows custom fragment shading on particle geometry
// Injected into the Pixel Shader section of a GLSL MAT

// Standard uniforms (provided by TD)
uniform float uTime;
uniform float uSpellEnergy;
uniform float uSpellMode;

// Material properties
uniform float uRoughness;
uniform float uMetallic;
uniform float uEmission;

// Available from vertex shader
// - iVert.uv[0] - texture coordinates
// - iVert.worldSpacePos - world position
// - iVert.camSpacePos - camera space position
// - iVert.worldSpaceNorm - world space normal
// - vColor - particle color from color_over_life

// Output structure (modify these)
// - oColor - final RGBA output
// - oEmissive - emissive color RGB
// - oRoughness - surface roughness
// - oMetallic - metallic factor

void main() {
    vec2 uv = iVert.uv[0].st;
    vec3 normal = normalize(iVert.worldSpaceNorm);
    vec3 worldPos = iVert.worldSpacePos.xyz;
    vec4 baseColor = vColor;  // From color_over_life

    // Default output
    vec4 color = baseColor;
    vec3 emission = vec3(0.0);
    float roughness = uRoughness;
    float metallic = uMetallic;

    // {zone_code}

    // Apply outputs
    oColor = TDOutputSwizzle(color);
    oEmissive = emission * uEmission;
    oRoughness = roughness;
    oMetallic = metallic;
}
