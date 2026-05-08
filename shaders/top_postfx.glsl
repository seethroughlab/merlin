// Post-FX shader template for glslTOP
// Inputs:
//   sTD2DInputs[0] - composite scene (particles + webcam)
//   sTD2DInputs[1] - Gaussian-blurred particle render (for bloom compositing)
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

    // Default bloom: composite the pre-blurred particle layer additively,
    // modulated by spell energy so the glow pulses with the cast envelope.
    // Zone code can sample sTD2DInputs[1] (or the `blurred` local) again
    // for additional layered effects.
    vec4 blurred = texture(sTD2DInputs[1], uv);
    color.rgb += blurred.rgb * uBloomIntensity * (0.3 + uSpellEnergy * 0.7);

    // Default vignette: subtle, intensifies with spell energy.
    // Applied AFTER bloom so corners properly darken the bloomed contribution.
    float vignette = 1.0 - length(uv - 0.5) * uVignetteStrength * uSpellEnergy;
    color.rgb *= vignette;

    // {zone_code}

    fragColor = color;
}
