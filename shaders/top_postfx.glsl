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

// Sprite-derived palette — same uniforms as in the billboard pixel shader.
// Wired by ws_callbacks._wire_spell_state_uniforms onto every shader op
// including glsl_postfx. Declared in source so glslTOP knows their type.
uniform vec3 uSpriteColor1;
uniform vec3 uSpriteColor2;

out vec4 fragColor;

// Per-particle hash for stable, well-distributed random values. Available
// in every POP/TOP/MAT zone so user snippets can call hash31(id) anywhere.
vec3 hash31(float p) {
    vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}

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

{zone_code}

    fragColor = color;
}
