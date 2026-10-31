"use client";

import { useEffect, useRef } from "react";
import cn from "clsx";

const VERTEX = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT = `
#extension GL_OES_standard_derivatives : enable
precision highp float;

uniform vec2 resolution;
uniform vec2 pointer;
uniform float strength;
uniform float time;

vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }

float noise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.y;
  vec2 cursor = pointer / resolution.y;

  float height = noise(uv * 1.6 + vec2(time * 0.03, time * 0.02)) * 0.6
               + noise(uv * 3.4 - vec2(time * 0.02, 0.0)) * 0.25;

  float d = distance(uv, cursor);
  height += strength * 0.55 * exp(-d * d * 18.0);

  float bands = height * 14.0;
  float line = abs(fract(bands) - 0.5) / fwidth(bands);
  float stroke = 1.0 - min(line, 1.0);

  float major = abs(fract(bands / 5.0) - 0.5) / fwidth(bands / 5.0);
  float majorStroke = 1.0 - min(major * 0.7, 1.0);

  float glow = strength * exp(-d * d * 10.0);
  float fade = smoothstep(0.18, 0.62, gl_FragCoord.y / resolution.y);
  float alpha = (stroke * (0.06 + glow * 0.05) + majorStroke * 0.035) * fade;

  vec3 ink = vec3(0.08, 0.1, 0.16);
  gl_FragColor = vec4(ink * alpha, alpha);
}
`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

export default function ContourField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const gl = canvas.getContext("webgl", {
      premultipliedAlpha: true,
      antialias: false,
    });
    if (!gl || !gl.getExtension("OES_standard_derivatives")) return;

    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vertex || !fragment) return;
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uResolution = gl.getUniformLocation(program, "resolution");
    const uPointer = gl.getUniformLocation(program, "pointer");
    const uStrength = gl.getUniformLocation(program, "strength");
    const uTime = gl.getUniformLocation(program, "time");

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const target = { x: 0, y: 0, strength: 0 };
    const current = { x: 0, y: 0, strength: 0 };
    let visible = true;
    let frame = 0;
    const start = performance.now();

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio, 1.5);
      canvas.width = Math.round(host.clientWidth * ratio);
      canvas.height = Math.round(host.clientHeight * ratio);
      gl.viewport(0, 0, canvas.width, canvas.height);
      current.x = target.x = canvas.width * 0.7;
      current.y = target.y = canvas.height * 0.6;
    };

    const draw = () => {
      current.x += (target.x - current.x) * 0.08;
      current.y += (target.y - current.y) * 0.08;
      current.strength += (target.strength - current.strength) * 0.05;
      gl.uniform2f(uResolution, canvas.width, canvas.height);
      gl.uniform2f(uPointer, current.x, current.y);
      gl.uniform1f(uStrength, current.strength);
      gl.uniform1f(uTime, reduced ? 0 : (performance.now() - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const loop = () => {
      draw();
      frame = visible && !reduced ? requestAnimationFrame(loop) : 0;
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const ratio = canvas.width / rect.width;
      target.x = (event.clientX - rect.left) * ratio;
      target.y = (rect.bottom - event.clientY) * ratio;
      target.strength = 1;
      if (reduced) draw();
    };
    const onPointerLeave = () => {
      target.strength = 0;
    };

    const resizeObserver = new ResizeObserver(() => {
      resize();
      draw();
    });
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !frame && !reduced) loop();
    });

    const area = host.closest("section") ?? host;
    resizeObserver.observe(host);
    intersectionObserver.observe(canvas);
    area.addEventListener("pointermove", onPointerMove);
    area.addEventListener("pointerleave", onPointerLeave);
    resize();
    loop();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      area.removeEventListener("pointermove", onPointerMove);
      area.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 size-full",
        className,
      )}
    />
  );
}
