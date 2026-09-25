// Change-point detection (plan §B): separates a regime shift from a one-bar spike.
//  - Two-sided CUSUM on standardized returns (Page 1954).
//  - Bayesian Online Change-Point Detection (Adams & MacKay 2007) on standardized
//    returns with a Normal-Gamma prior (zero-mean, unknown precision → captures
//    volatility regime changes) and a constant hazard. The run-length distribution
//    is truncated at `maxRun` so each update costs O(maxRun).

export class Cusum {
  readonly k: number;
  readonly h: number;
  pos = 0;
  neg = 0;
  constructor(k = 0.5, h = 5) {
    this.k = k;
    this.h = h;
  }
  /** Returns +1 / -1 when an up/down shift is detected (and resets), else 0. */
  update(z: number): 1 | -1 | 0 {
    this.pos = Math.max(0, this.pos + z - this.k);
    this.neg = Math.max(0, this.neg - z - this.k);
    if (this.pos > this.h) { this.reset(); return 1; }
    if (this.neg > this.h) { this.reset(); return -1; }
    return 0;
  }
  reset(): void {
    this.pos = 0;
    this.neg = 0;
  }
}

function lgamma(x: number): number {
  // Lanczos approximation.
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Log pdf of a zero-mean Student-t with 2a dof and scale sqrt(b/a). */
function studentLogPdf(x: number, a: number, b: number): number {
  const nu = 2 * a;
  const s2 = b / a;
  return lgamma((nu + 1) / 2) - lgamma(nu / 2) - 0.5 * Math.log(nu * Math.PI * s2) - ((nu + 1) / 2) * Math.log(1 + (x * x) / (nu * s2));
}

export class Bocpd {
  readonly hazard: number;
  readonly maxRun: number;
  private logR: number[] = [0]; // log P(run length = i)
  private a: number[];
  private b: number[];
  private readonly a0: number;
  private readonly b0: number;
  n = 0;

  constructor(hazard = 1 / 250, maxRun = 300, a0 = 1, b0 = 1) {
    this.hazard = hazard;
    this.maxRun = maxRun;
    this.a0 = a0;
    this.b0 = b0;
    this.a = [a0];
    this.b = [b0];
  }

  /**
   * Feed one standardized observation. Returns the posterior probability that a
   * change occurred within the last `recent` observations.
   */
  update(x: number, recent = 5): number {
    this.n++;
    const L = this.logR.length;
    const logPred = new Array<number>(L);
    for (let i = 0; i < L; i++) logPred[i] = studentLogPdf(x, this.a[i], this.b[i]);
    const lh = Math.log(this.hazard);
    const l1h = Math.log(1 - this.hazard);
    const growth = new Array<number>(L);
    const cpTerms = new Array<number>(L);
    for (let i = 0; i < L; i++) {
      growth[i] = this.logR[i] + logPred[i] + l1h;
      cpTerms[i] = this.logR[i] + logPred[i] + lh;
    }
    let next = [logSumExp(cpTerms), ...growth];
    // Posterior update of the Normal-Gamma (zero mean) parameters for each run length.
    let na = [this.a0, ...this.a.map((v) => v + 0.5)];
    let nb = [this.b0, ...this.b.map((v) => v + (x * x) / 2)];
    if (next.length > this.maxRun) {
      next = next.slice(0, this.maxRun);
      na = na.slice(0, this.maxRun);
      nb = nb.slice(0, this.maxRun);
    }
    const z = logSumExp(next);
    this.logR = next.map((v) => v - z);
    this.a = na;
    this.b = nb;
    let p = 0;
    for (let i = 0; i < Math.min(recent, this.logR.length); i++) p += Math.exp(this.logR[i]);
    return this.n > recent * 4 ? p : 0;
  }

  /** Most likely current run length. */
  mapRunLength(): number {
    let best = 0;
    for (let i = 1; i < this.logR.length; i++) if (this.logR[i] > this.logR[best]) best = i;
    return best;
  }
}

function logSumExp(xs: number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  if (m === -Infinity) return m;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}
