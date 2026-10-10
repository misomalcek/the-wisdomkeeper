// Fit the spear's axis: the straightest contiguous run of vertices hanging down from the model's highest point.
export function findAxis(P, step = 11) {
  const n = P.length / 3;
  let top = 0;
  for (let i = 0; i < n; i++) if (P[i * 3 + 1] > P[top * 3 + 1]) top = i;
  const T = [P[top * 3], P[top * 3 + 1], P[top * 3 + 2]];
  const rel = (stride) => {
    const out = [];
    for (let i = 0; i < n; i += stride) out.push(P[i * 3] - T[0], P[i * 3 + 1] - T[1], P[i * 3 + 2] - T[2]);
    return Float32Array.from(out);
  };
  const run = (R, d, r) => {
    const bins = new Uint8Array(150);
    for (let k = 0; k < R.length; k += 3) {
      const t = R[k] * d[0] + R[k + 1] * d[1] + R[k + 2] * d[2];
      if (t < 0 || t >= 1.45) continue;
      if (R[k] * R[k] + R[k + 1] * R[k + 1] + R[k + 2] * R[k + 2] - t * t < r * r) bins[(t * 100) | 0] = 1;
    }
    let L = 0;
    while (L < 147 && (bins[L] || bins[L + 1] || bins[L + 2])) L++;
    return L;
  };
  const dir = (th, ph) => [Math.sin(th) * Math.cos(ph), -Math.cos(th), Math.sin(th) * Math.sin(ph)];
  const coarse = rel(step);
  let best = { L: -1 };
  for (let th = 0.02; th < 1.3; th += 0.025) for (let ph = 0; ph < Math.PI * 2; ph += 0.04) {
    const d = dir(th, ph);
    const L = run(coarse, d, 0.016);
    if (L > best.L) best = { L, th, ph, d };
  }
  const fine = rel(2);
  const c = best;
  best = { L: -1 };
  for (let th = c.th - 0.03; th <= c.th + 0.03; th += 0.003) for (let ph = c.ph - 0.05; ph <= c.ph + 0.05; ph += 0.004) {
    const d = dir(th, ph);
    const L = run(fine, d, 0.01);
    if (L > best.L) best = { L, th, ph, d };
  }
  return { tip: T, d: best.d, length: best.L / 100 };
}
