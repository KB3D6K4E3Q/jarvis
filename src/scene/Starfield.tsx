import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { Drive } from './Scene'

/**
 * Deep space behind the reactor, for the scroll dive.
 *
 * At rest it is barely there: a faint scatter that gives the dark some depth
 * without competing with the ring. As the dive goes in it brightens, and the
 * whole field slides toward the camera, so passing through the orbit rings
 * ends in open space rather than in a black screen.
 *
 * Stars wrap round in depth rather than running out, so the field is always
 * full however far the slide has gone.
 */

const COUNT = 5200
/** The star volume runs from FAR to NEAR along z, around the reactor at 0. */
const FAR = -60
const NEAR = 6
/** How far the field slides toward the camera across a full dive. */
const TRAVEL = 22
/** Brightness at rest, before the dive brings the stars up. */
const REST_ALPHA = 0.12
const MAX_POINT_PX = 10
/** Overall star brightness once the dive has brought them up. */
const STAR_GAIN = 1.6

/** Mostly warm white with gold and a little of the reactor's cyan. */
const PALETTE = ['#fff4e0', '#ffd48a', '#ffb35c', '#cfefff', '#7fe9ff'].map(
  (c) => new THREE.Color(c),
)
const PALETTE_WEIGHTS = [0.42, 0.24, 0.12, 0.14, 0.08]

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uTravel;

  attribute vec3 aColor;
  attribute float aSize;
  attribute float aSeed;

  varying vec3 vColor;
  varying float vTwinkle;

  void main() {
    vec3 p = position;
    float span = ${(NEAR - FAR).toFixed(1)};
    p.z = mod(p.z - ${FAR.toFixed(1)} + uTravel * ${TRAVEL.toFixed(1)}, span) + ${FAR.toFixed(1)};

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    vColor = aColor;
    // Fade in from the far end and out right at the lens, so the wrap never
    // shows as a star popping into existence.
    vTwinkle = (0.65 + 0.35 * sin(uTime * (1.2 + aSeed * 2.4) + aSeed * 40.0))
             * smoothstep(-58.0, -40.0, mv.z)
             * (1.0 - smoothstep(-1.5, -0.3, mv.z));
    gl_PointSize = min(aSize * (34.0 / -mv.z), ${MAX_POINT_PX.toFixed(1)});
  }
`

const fragment = /* glsl */ `
  uniform float uAlpha;
  varying vec3 vColor;
  varying float vTwinkle;

  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d);
    if (r > 0.5) discard;
    // A hot centre with a soft halo — bloom does the rest.
    float core = 1.0 - smoothstep(0.0, 0.18, r);
    float halo = 1.0 - smoothstep(0.0, 0.5, r);
    gl_FragColor = vec4(vColor, (core * 0.8 + halo * 0.35) * vTwinkle * uAlpha);
  }
`

function pickColor(): THREE.Color {
  let roll = Math.random()
  for (let i = 0; i < PALETTE.length; i++) {
    roll -= PALETTE_WEIGHTS[i]
    if (roll <= 0) return PALETTE[i]
  }
  return PALETTE[0]
}

function buildStars() {
  const positions = new Float32Array(COUNT * 3)
  const colors = new Float32Array(COUNT * 3)
  const sizes = new Float32Array(COUNT)
  const seeds = new Float32Array(COUNT)
  for (let i = 0; i < COUNT; i++) {
    // A wide tube around the line of flight, kept clear down the middle so
    // nothing sits on top of the reactor itself.
    const angle = Math.random() * Math.PI * 2
    const radius = 2.6 + Math.pow(Math.random(), 0.8) * 20
    positions[i * 3] = Math.cos(angle) * radius
    positions[i * 3 + 1] = Math.sin(angle) * radius * 0.7
    positions[i * 3 + 2] = FAR + Math.random() * (NEAR - FAR)
    pickColor().toArray(colors, i * 3)
    sizes[i] = 0.6 + Math.pow(Math.random(), 3) * 2.2
    seeds[i] = Math.random()
  }
  return { positions, colors, sizes, seeds }
}

/** Size of the quad the central star is painted on, in world units. */
const SUN_SIZE = 3.2
const SUN_COLOR = new THREE.Color('#ffd28c')
/** How sharply the star fades, and how much it shrinks, as the camera passes. */
const SUN_FADE_POWER = 3
const SUN_SHRINK = 0.65

const sunVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const sunFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uTime;
  varying vec2 vUv;

  void main() {
    float r = length(vUv - 0.5) * 2.0;
    // A white-hot pin inside a wide warm haze — the haze is what bloom grabs.
    float pin = exp(-r * r * 90.0);
    float haze = exp(-r * r * 7.0) * (0.85 + 0.15 * sin(uTime * 1.7));
    vec3 col = mix(uColor, vec3(1.0), pin);
    gl_FragColor = vec4(col, (pin + haze * 0.55) * uAlpha);
  }
`

/**
 * The warm star at the heart of the orbit rings. It takes over from the
 * reactor ring as that fades on the dive, so the rings always circle a light
 * rather than a hole, and it dims again as the camera goes past it.
 */
function CoreStar({ drive }: { drive: Drive }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const mesh = useRef<THREE.Mesh>(null)
  const uniforms = useMemo(
    () => ({
      uColor: { value: SUN_COLOR.clone() },
      uAlpha: { value: 0 },
      uTime: { value: 0 },
    }),
    [],
  )

  useFrame((state) => {
    if (!mat.current || !mesh.current) return
    const { rings, through } = drive.dive
    // Falls away steeply on the fly-through: the quad is a fixed size in the
    // world, so with the camera closing on it the haze would fill the frame.
    const alpha = rings * Math.pow(1 - through, SUN_FADE_POWER)
    mesh.current.visible = alpha > 0.001
    mesh.current.scale.setScalar(1 - through * SUN_SHRINK)
    mesh.current.quaternion.copy(state.camera.quaternion)
    mat.current.uniforms.uAlpha.value = alpha
    mat.current.uniforms.uTime.value = state.clock.elapsedTime
  })

  return (
    <mesh ref={mesh} visible={false} frustumCulled={false}>
      <planeGeometry args={[SUN_SIZE, SUN_SIZE]} />
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={sunVertex}
        fragmentShader={sunFragment}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </mesh>
  )
}

export function Starfield({ drive }: { drive: Drive }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const stars = useMemo(buildStars, [])
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uTravel: { value: 0 },
      uAlpha: { value: REST_ALPHA },
    }),
    [],
  )

  useFrame((state) => {
    if (!mat.current) return
    const u = mat.current.uniforms
    const { stars: shown, through } = drive.dive
    u.uTime.value = state.clock.elapsedTime
    u.uAlpha.value = REST_ALPHA + (STAR_GAIN - REST_ALPHA) * shown
    u.uTravel.value = through
  })

  // Culling off: the shader moves every star, so the authored bounds lie.
  return (
    <>
      <CoreStar drive={drive} />
      <points frustumCulled={false} renderOrder={-1}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[stars.positions, 3]} />
          <bufferAttribute attach="attributes-aColor" args={[stars.colors, 3]} />
          <bufferAttribute attach="attributes-aSize" args={[stars.sizes, 1]} />
          <bufferAttribute attach="attributes-aSeed" args={[stars.seeds, 1]} />
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
    </>
  )
}
