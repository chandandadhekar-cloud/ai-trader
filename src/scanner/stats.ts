// Streaming statistics primitives (plan §B): Welford, EWMA mean/variance,
// P² quantile estimator (Jain & Chlamtac 1985) and a Count-Min sketch for
// keyword bursts. All O(1) per update.

export class Welford {
  n = 0;
  mean = 0;
  private m2 = 0;
  push(x: number): void {
    this.n++;
    const d = x - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (x - this.mean);
  }
  variance(): number {
    return this.n > 1 ? this.m2 / (this.n - 1) : 0;
  }
  std(): number {
    return Math.sqrt(this.variance());
  }
}

export class Ewma {
  readonly alpha: number;
  mean = 0;
  var = 0;
  n = 0;
  constructor(alpha: number) {
    this.alpha = alpha;
  }
  push(x: number): void {
    if (this.n === 0) {
      this.mean = x;
      this.var = 0;
    } else {
      const d = x - this.mean;
      this.mean += this.alpha * d;
      this.var = (1 - this.alpha) * (this.var + this.alpha * d * d);
    }
    this.n++;
  }
  std(): number {
    return Math.sqrt(this.var);
  }
  z(x: number): number | undefined {
    const s = this.std();
    return this.n >= 10 && s > 0 ? (x - this.mean) / s : undefined;
  }
}

/** P² algorithm: running estimate of a single quantile p without storing data. */
export class P2Quantile {
  readonly p: number;
  private q: number[] = [];
  private n: number[] = [0, 1, 2, 3, 4];
  private np: number[];
  private dn: number[];
  private count = 0;

  constructor(p: number) {
    this.p = p;
    this.np = [0, 2 * p, 4 * p, 2 + 2 * p, 4];
    this.dn = [0, p / 2, p, (1 + p) / 2, 1];
  }

  push(x: number): void {
    this.count++;
    if (this.q.length < 5) {
      this.q.push(x);
      if (this.q.length === 5) this.q.sort((a, b) => a - b);
      return;
    }
    let k: number;
    if (x < this.q[0]) { this.q[0] = x; k = 0; }
    else if (x < this.q[1]) k = 0;
    else if (x < this.q[2]) k = 1;
    else if (x < this.q[3]) k = 2;
    else if (x <= this.q[4]) k = 3;
    else { this.q[4] = x; k = 3; }
    for (let i = k + 1; i < 5; i++) this.n[i]++;
    for (let i = 0; i < 5; i++) this.np[i] += this.dn[i];
    for (let i = 1; i < 4; i++) {
      const d = this.np[i] - this.n[i];
      if ((d >= 1 && this.n[i + 1] - this.n[i] > 1) || (d <= -1 && this.n[i - 1] - this.n[i] < -1)) {
        const s = Math.sign(d);
        const qp = this.parabolic(i, s);
        this.q[i] = this.q[i - 1] < qp && qp < this.q[i + 1] ? qp : this.linear(i, s);
        this.n[i] += s;
      }
    }
  }

  private parabolic(i: number, d: number): number {
    const { q, n } = this;
    return q[i] + (d / (n[i + 1] - n[i - 1])) * ((n[i] - n[i - 1] + d) * (q[i + 1] - q[i]) / (n[i + 1] - n[i]) + (n[i + 1] - n[i] - d) * (q[i] - q[i - 1]) / (n[i] - n[i - 1]));
  }

  private linear(i: number, d: number): number {
    return this.q[i] + (d * (this.q[i + d] - this.q[i])) / (this.n[i + d] - this.n[i]);
  }

  value(): number | undefined {
    if (this.count === 0) return undefined;
    if (this.q.length < 5) {
      const s = [...this.q].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(this.p * s.length))];
    }
    return this.q[2];
  }
}

/** Count-Min sketch for approximate token frequencies (news keyword bursts). */
export class CountMin {
  private readonly w: number;
  private readonly d: number;
  private table: Uint32Array;
  constructor(width = 2048, depth = 4) {
    this.w = width;
    this.d = depth;
    this.table = new Uint32Array(width * depth);
  }
  private h(s: string, i: number): number {
    let h = 2166136261 ^ (i * 16777619);
    for (let j = 0; j < s.length; j++) h = Math.imul(h ^ s.charCodeAt(j), 16777619);
    return (h >>> 0) % this.w;
  }
  add(s: string, c = 1): void {
    for (let i = 0; i < this.d; i++) this.table[i * this.w + this.h(s, i)] += c;
  }
  estimate(s: string): number {
    let m = Infinity;
    for (let i = 0; i < this.d; i++) m = Math.min(m, this.table[i * this.w + this.h(s, i)]);
    return m;
  }
  decay(f = 0.5): void {
    for (let i = 0; i < this.table.length; i++) this.table[i] = Math.floor(this.table[i] * f);
  }
}

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
