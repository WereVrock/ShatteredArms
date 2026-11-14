import * as THREE from 'three';

// Water surface materials.
//
//   createWaterMaterial()        full effects: depth tint, rippled normals,
//                                caustics in the shallows, fresnel sky,
//                                sun highlight and glints, lapping shore foam.
//   createSimpleWaterMaterial()  flat, static, translucent tint. Used when
//                                the "water effects" setting is off.
//
// Both support scene fog and share the vertex stage.
// Vertex attribute aWater = (wet, depth), see WaterField.

const VERTEX = /* glsl */`
attribute vec2 aWater;
varying vec2 vWater;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vWater = aWater;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

// colorspace_fragment replaced encodings_fragment in three r154.
function colorSpaceChunk() {
  const rev = parseInt(THREE.REVISION, 10);
  return rev >= 154 ? '#include <colorspace_fragment>' : '#include <encodings_fragment>';
}

function fullFragment() {
  return /* glsl */`
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSky;
uniform vec3 uFoam;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
varying vec2 vWater;
varying vec3 vWorld;
#include <fog_pars_fragment>

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Height-field gradient of a few travelling waves.
vec2 waveGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  vec2 d; float f; float s;
  d = vec2(0.92, 0.38);   f = 0.85; s = dot(d, p) * f + t * 1.10; g += d * f * 0.050 * cos(s);
  d = vec2(-0.35, 0.94);  f = 1.30; s = dot(d, p) * f + t * 1.45; g += d * f * 0.040 * cos(s);
  d = vec2(0.71, -0.70);  f = 2.10; s = dot(d, p) * f + t * 1.90; g += d * f * 0.025 * cos(s);
  d = vec2(-0.80, -0.60); f = 3.40; s = dot(d, p) * f + t * 2.60; g += d * f * 0.015 * cos(s);
  return g;
}

// Scrolling noise ripples on top of the waves.
float detail(vec2 p, float t) {
  return vnoise(p * 1.5 + vec2(t * 0.30, t * 0.18))
       + 0.5 * vnoise(p * 3.1 - vec2(t * 0.26, -t * 0.37));
}

void main() {
  vec2 p = vWorld.xz;
  float t = uTime;

  // Organic shoreline: wobble the cut-off with low-frequency noise.
  float shoreWobble = (vnoise(p * 0.8) - 0.5) * 0.22 + (vnoise(p * 2.5 + 7.0) - 0.5) * 0.08;
  float wet = vWater.x + shoreWobble;
  if (wet < 0.45) discard;
  // 0 at the water's edge, 1 one cell inside.
  float sd = clamp((wet - 0.45) / 0.5, 0.0, 1.0);

  // Surface normal from waves + detail ripples.
  vec2 g = waveGrad(p, t);
  const float E = 0.18;
  float d0 = detail(p, t);
  vec2 g2 = vec2(detail(p + vec2(E, 0.0), t) - d0, detail(p + vec2(0.0, E), t) - d0) / E;
  vec3 n = normalize(vec3(-(g.x + g2.x * 0.07), 1.0, -(g.y + g2.y * 0.07)));

  vec3 v = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);

  float depth = clamp(vWater.y, 0.0, 1.0);
  vec3 col = mix(uShallow, uDeep, smoothstep(0.05, 0.85, depth));

  // Caustic web in the shallows: bright where two drifting noises agree.
  float cA = vnoise(p * 1.1 + vec2(t * 0.22, t * 0.17));
  float cB = vnoise(p * 1.45 - vec2(t * 0.19, t * 0.25) + 11.0);
  float caus = pow(clamp(1.0 - abs(cA - cB) * 4.0, 0.0, 1.0), 3.0);
  col += vec3(0.55, 0.85, 0.80) * caus * 0.22 * (1.0 - smoothstep(0.0, 0.6, depth));

  col = mix(col, uSky, fres * 0.55);

  // Sun: soft highlight plus sparkling glints.
  vec3 sun = normalize(uSunDir);
  vec3 r = reflect(-sun, n);
  float rv = max(dot(r, v), 0.0);
  col += uSunColor * pow(rv, 90.0) * 0.8;
  float glint = smoothstep(0.80, 0.94, vnoise(p * 6.0 + vec2(t * 1.3, -t * 0.9)));
  col += uSunColor * glint * pow(rv, 6.0) * 0.9;

  // Shore foam: a band that laps in and out, broken up by noise, plus a
  // thin line right at the edge.
  float lap = 0.5 + 0.5 * sin(t * 0.9 + p.x * 0.15 + p.y * 0.11);
  float band = smoothstep(0.0, 0.06, sd)
             * (1.0 - smoothstep(0.10 + 0.10 * lap, 0.28 + 0.12 * lap, sd));
  float fn = vnoise(p * 2.3 + vec2(t * 0.3, 0.0));
  float foam = clamp(band * (0.35 + fn * 0.9) + (1.0 - smoothstep(0.0, 0.12, sd)) * 0.55, 0.0, 1.0);
  col = mix(col, uFoam, foam * 0.75);

  float alpha = mix(0.52, 0.92, smoothstep(0.0, 0.6, depth));
  alpha = max(alpha, fres * 0.6);
  alpha = max(alpha, foam * 0.8);
  alpha *= smoothstep(0.0, 0.14, sd);

  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  ${colorSpaceChunk()}
  #include <fog_fragment>
}
`;
}

function simpleFragment() {
  return /* glsl */`
uniform vec3 uShallow;
uniform vec3 uDeep;
varying vec2 vWater;
#include <fog_pars_fragment>
void main() {
  if (vWater.x < 0.5) discard;
  float d = clamp(vWater.y, 0.0, 1.0);
  gl_FragColor = vec4(mix(uShallow, uDeep, d), mix(0.62, 0.90, d));
  ${colorSpaceChunk()}
  #include <fog_fragment>
}
`;
}

// Matches SceneSetup's SUN_OFFSET direction.
const SUN_DIR = new THREE.Vector3(40, 55, 25).normalize();

const SHALLOW = 0x58b2b0;
const DEEP = 0x153f66;

// Accepts a hex number, an [r,g,b] byte array (the BiomeVisuals format),
// an existing THREE.Color, or undefined (uses fallback). Returns a NEW
// THREE.Color so the caller can mutate uniforms freely.
function toColor(v, fallback) {
  if (v && v.isColor) return v.clone();
  if (Array.isArray(v) && v.length >= 3) {
    return new THREE.Color(v[0] / 255, v[1] / 255, v[2] / 255);
  }
  if (typeof v === 'number') return new THREE.Color(v);
  return new THREE.Color(fallback);
}

function baseMaterial(uniforms, fragmentShader) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    // Water is only ever seen from above (the camera pitch is clamped
    // above the horizon), so backfaces are never visible.
    side: THREE.FrontSide,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4
  });
}

// opts.shallow / opts.deep override the biome water colours. Both accept
// hex numbers, [r,g,b] byte arrays (BiomeVisuals format) or THREE.Color
// instances. When omitted, the pre-biome defaults (SHALLOW / DEEP) are
// used, so every existing caller that passes no options keeps its exact
// previous look.
export function createWaterMaterial(opts = {}) {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uShallow: { value: toColor(opts.shallow, SHALLOW) },
      uDeep: { value: toColor(opts.deep, DEEP) },
      uSky: { value: new THREE.Color(0xa9cbe3) },
      uFoam: { value: new THREE.Color(0xf2f8fa) },
      uSunColor: { value: new THREE.Color(0xfff0cc) },
      uSunDir: { value: SUN_DIR.clone() }
    }
  ]);
  return baseMaterial(uniforms, fullFragment());
}

// Cheap variant for weak machines: static, no noise, no animation.
export function createSimpleWaterMaterial(opts = {}) {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uShallow: { value: toColor(opts.shallow, SHALLOW) },
      uDeep: { value: toColor(opts.deep, DEEP) }
    }
  ]);
  return baseMaterial(uniforms, simpleFragment());
}