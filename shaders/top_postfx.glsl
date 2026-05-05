// Post-FX shader template for glslTOP
// Input: sTD2DInputs[0] - the rendered scene
// Output: fragColor - processed image

// Standard uniforms
uniform float uTime;
uniform float uSpellEnergy;
uniform float uSpellMode;

// Post-FX specific uniforms
uniform float uBloomIntensity;
uniform float uVignetteStrength;
uniform float uChromaticAberration;

out vec4 fragColor;

void main() {
    vec2 uv = vUV.st;
    vec4 color = texture(sTD2DInputs[0], uv);

    // Default: subtle vignette based on spell energy
    float vignette = 1.0 - length(uv - 0.5) * uVignetteStrength * uSpellEnergy;
    color.rgb *= vignette;

    // {zone_code}

    fragColor = color;
}
