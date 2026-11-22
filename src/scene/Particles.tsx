import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Drive } from './Scene'

/**
 * A shell of points around the core. Each one drifts on its own orbit and gets
 * pushed outward by loudness, so the whole cloud expands when JARVIS speaks.
 */

const COUNT = 4000

/**
 * The orbit rings the dust gathers into on the scroll dive: Euler tilt in
 * degrees, radius, and spin in radians per second. Mixed flat and steep tilts
 * so the set reads as a gyroscope cage around the core rather than a target.
 */
const RINGS: ReadonlyArray<{ tilt: [number, number, number]; radius: number; spin: number }> = [
  { tilt: [76, 0, 0], radius: 1.8, spin: 0.22 },
  { tilt: [8, 28, 0], radius: 1.45, spin: -0.3 },
  { tilt: [-6, -38, 12], radius: 1.55, spin: 0.26 },
  { tilt: [58, 0, 34], radius: 1.25, spin: -0.36 },
  { tilt: [64, 0, -48], radius: 0.95, spin: 0.44 },
]
/** Spread of each point off its ring's centre line, as a fraction of radius. */
const RING_THICKNESS = 0.018
/** How far the rings widen as the camera passes through them. */
const RING_FLY_OUT = 4.5
/** Largest point sprite, in pixels, so dust right at the lens stays a speck. */
const MAX_POINT_PX = 26

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uLevel;
  uniform float uSize;
  uniform float uRings;
  uniform float uThrough;
  uniform float uRingTime;

  attribute float aSeed;
  attribute float aRadius;
  attribute vec3 aRingU;
  attribute vec3 aRingV;
  attribute float aRingR;
  attribute float aRingAngle;
  attribute float aRingSpin;

  varying float vAlpha;

  void main() {
    float t = uTime * (0.06 + aSeed * 0.05);

    // Rotate each point about Y at its own rate — cheap parallax.
    float c = cos(t), s = sin(t);
    vec3 shell = vec3(position.x * c - position.z * s, position.y, position.x * s + position.z * c);

    // The same point's place on its orbit ring, carried round at the ring's
    // rate and widened out past the camera as the dive goes through.
    float a = aRingAngle + uRingTime * aRingSpin;
    vec3 ring = (aRingU * cos(a) + aRingV * sin(a)) * aRingR * (1.0 + uThrough * ${RING_FLY_OUT.toFixed(2)});

    // At rest uRings is zero and this is the shell exactly as it always was.
    vec3 p = mix(shell, ring, uRings);

    // Loudness pushes the shell out and adds a little jitter.
    float push = 1.0 + uLevel * 0.35 + sin(uTime * 2.0 + aSeed * 12.0) * 0.02;
    p *= push;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // Fade the far side so the cloud reads as volumetric, and thin it out
    // toward the outer edge of the shell.
    //
    // The range is the actual geometry: the camera sits 6.2 out and the shell
    // spans 1.9 to 4.5, so view depth runs from about -1.7 at the front to
    // -10.7 at the back. The old window closed at -3.5, which put nine tenths
    // of the cloud at alpha zero while still shading and rasterising every one
    // of those points.
    float shellAlpha = (0.30 + uLevel * 0.35) * (1.0 - aRadius * 0.55);
    // Ring dust is packed tight on a line, so it glows brighter than the
    // loose shell, then thins as the rings sweep out past the lens.
    float ringAlpha = (0.62 + uLevel * 0.3) * (1.0 - uThrough * 0.55);
    vAlpha = smoothstep(-11.5, -2.5, mv.z)
           * (1.0 - smoothstep(-1.2, -0.25, mv.z))
           * mix(shellAlpha, ringAlpha, uRings);

    // Perspective-correct sizing. The constant is tuned for the default 6-unit
    // camera distance — bigger values make the cloud read as fog, not points.
    // Capped, because the dive brings dust right up to the lens.
    gl_PointSize = min(
      uSize * (1.0 + uLevel * 0.7) * (13.0 / -mv.z),
      ${MAX_POINT_PX.toFixed(1)}
    );
  }
`

/** Unit basis vectors for each ring, built once from RINGS' Euler tilts. */
const RING_BASES = RINGS.map(({ tilt }) => {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(tilt[0]),
    THREE.MathUtils.degToRad(tilt[1]),
    THREE.MathUtils.degToRad(tilt[2]),
  )
  return {
    u: new THREE.Vector3(1, 0, 0).applyEuler(euler),
    v: new THREE.Vector3(0, 1, 0).applyEuler(euler),
  }
})

const fragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying float vAlpha;

  void main() {
    // Round, soft-edged points.
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (r > 0.5) discard;
    float falloff = 1.0 - smoothstep(0.0, 0.5, r);
    // The dust belongs to the orb: turning the reactor down and leaving its own
    // atmosphere at full brightness reads as a bug, not as a dimmer.
    gl_FragColor = vec4(uColor, vAlpha * falloff * uIntensity);
  }
`

export function Particles({ drive }: { drive: Drive }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const pts = useRef<THREE.Points>(null)

  const { positions, seeds, radii, ring } = useMemo(() => {
    const positions = new Float32Array(COUNT * 3)
    const seeds = new Float32Array(COUNT)
    const radii = new Float32Array(COUNT)
    const ring = {
      u: new Float32Array(COUNT * 3),
      v: new Float32Array(COUNT * 3),
      r: new Float32Array(COUNT),
      angle: new Float32Array(COUNT),
      spin: new Float32Array(COUNT),
    }
    for (let i = 0; i < COUNT; i++) {
      const k = i % RINGS.length
      const basis = RING_BASES[k]
      basis.u.toArray(ring.u, i * 3)
      basis.v.toArray(ring.v, i * 3)
      ring.r[i] = RINGS[k].radius * (1 + (Math.random() - 0.5) * 2 * RING_THICKNESS)
      ring.angle[i] = Math.random() * Math.PI * 2
      ring.spin[i] = RINGS[k].spin

      // Even distribution on a sphere, then jittered into a shell.
      const u = Math.random() * 2 - 1
      const theta = Math.random() * Math.PI * 2
      const r = Math.sqrt(1 - u * u)
      const radius = 1.9 + Math.pow(Math.random(), 2) * 2.6
      positions[i * 3] = Math.cos(theta) * r * radius
      positions[i * 3 + 1] = u * radius
      positions[i * 3 + 2] = Math.sin(theta) * r * radius
      seeds[i] = Math.random()
      radii[i] = (radius - 1.9) / 2.6
    }
    return { positions, seeds, radii, ring }
  }, [])

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uSize: { value: 3.4 },
      uColor: { value: new THREE.Color('#00e5ff') },
      uIntensity: { value: 1 },
      uRings: { value: 0 },
      uThrough: { value: 0 },
      uRingTime: { value: 0 },
    }),
    [],
  )

  useFrame((state, dt) => {
    if (!mat.current || !pts.current) return
    const u = mat.current.uniforms
    pts.current.visible = drive.reactor.visible
    u.uIntensity.value = drive.reactor.intensity
    u.uTime.value = state.clock.elapsedTime
    u.uLevel.value += (drive.level - u.uLevel.value) * Math.min(1, dt * 6)
    u.uRings.value = drive.dive.rings
    u.uThrough.value = drive.dive.through
    // Accumulated so the rings keep their place when the dive changes speed.
    u.uRingTime.value += dt
    ;(u.uColor.value as THREE.Color).lerp(drive.dust, Math.min(1, dt * 3))
  })

  // Each point's own orbit runs at a constant per-particle rate, so unlike the
  // core the shader can take the clock directly — nothing here rescales time by
  // a value that changes. Culling, though, is off for the same reason as the
  // core: loudness pushes the shell out past its authored radius.
  return (
    <points ref={pts} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
        <bufferAttribute attach="attributes-aSeed" args={[seeds, 1]} />
        <bufferAttribute attach="attributes-aRadius" args={[radii, 1]} />
        <bufferAttribute attach="attributes-aRingU" args={[ring.u, 3]} />
        <bufferAttribute attach="attributes-aRingV" args={[ring.v, 3]} />
        <bufferAttribute attach="attributes-aRingR" args={[ring.r, 1]} />
        <bufferAttribute attach="attributes-aRingAngle" args={[ring.angle, 1]} />
        <bufferAttribute attach="attributes-aRingSpin" args={[ring.spin, 1]} />
      </bufferGeometry>
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={vertex}
        fragmentShader={fragment}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  )
}
