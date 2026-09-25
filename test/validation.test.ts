import { gaussian } from './helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normCdf, normInv, sharpe } from '../src/validation/statsUtil.ts';
import { deflatedSharpe, expectedMaxSharpe, probabilisticSharpe } from '../src/validation/deflatedSharpe.ts';
import { pboCscv } from '../src/validation/pbo.ts';
import { realityCheck } from '../src/validation/realityCheck.ts';
import { purgedKFold, cpcv } from '../src/ml/cv.ts';
import { tripleBarrier } from '../src/ml/labeling.ts';
import { trainMetaModel, predictMeta, betSize } from '../src/ml/metaLabel.ts';
import { psi, ks2, PageHinkley, checkDecay } from '../src/ml/drift.ts';
import { evaluateGates } from '../src/validation/trialRegistry.ts';
import { fitIsotonic, applyIsotonic } from '../src/research/calibration.ts';
import type { Bar } from '../src/core/types.ts';

test('normal CDF / inverse are accurate', () => {
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normInv(0.975) - 1.959964) < 1e-5);
  assert.ok(Math.abs(normInv(normCdf(-2.3)) + 2.3) < 1e-5);
});

test('expected max Sharpe grows with the number of trials; DSR deflates a lucky pick', () => {
  assert.ok(expectedMaxSharpe(100, 0.01) > expectedMaxSharpe(10, 0.01));
  const g = gaussian(11);
  // 100 zero-skill strategies; pick the best in-sample.
  const series = Array.from({ length: 100 }, () => Array.from({ length: 250 }, () => g() * 0.01));
  const srs = series.map(sharpe);
  const best = series[srs.indexOf(Math.max(...srs))];
  const naive = probabilisticSharpe(sharpe(best), 0, 250, 0, 3);
  const d = deflatedSharpe(best, srs);
  assert.ok(naive > 0.9, `naive PSR ${naive}`);
  assert.ok(d.dsr < 0.95, `DSR should reject the lucky pick, got ${d.dsr}`);
  // A genuinely skilled series passes.
  const skilled = Array.from({ length: 750 }, () => 0.003 + g() * 0.01);
  assert.ok(deflatedSharpe(skilled, [...srs.slice(0, 10), sharpe(skilled)]).dsr > 0.95);
});

test('PBO: an overfit selection among noise is flagged; a dominant config is not', () => {
  const g = gaussian(21);
  const noise = Array.from({ length: 400 }, () => Array.from({ length: 20 }, () => g() * 0.01));
  const pNoise = pboCscv(noise, 8).pbo;
  assert.ok(pNoise > 0.3, `noise PBO ${pNoise}`);
  const skill = noise.map((row) => row.map((x, j) => (j === 0 ? x + 0.004 : x)));
  const pSkill = pboCscv(skill, 8).pbo;
  assert.ok(pSkill < 0.2, `skill PBO ${pSkill}`);
});

test('reality check: noise family is not significant, a real edge is', () => {
  const g = gaussian(31);
  const noise = Array.from({ length: 300 }, () => Array.from({ length: 10 }, () => g() * 0.01));
  assert.ok(realityCheck(noise, 300).pRealityCheck > 0.05);
  const edge = noise.map((r) => r.map((x, k) => (k === 3 ? x + 0.003 : x)));
  const rc = realityCheck(edge, 300);
  assert.ok(rc.pSpa < 0.05);
  assert.equal(rc.bestIndex, 3);
});

test('purged K-fold / CPCV: no training span overlaps any test span (+ embargo)', () => {
  const spans = Array.from({ length: 200 }, (_, i) => ({ t0: i * 10, t1: i * 10 + 35 }));
  for (const sp of [...purgedKFold(spans, 5, 20), ...cpcv(spans, 6, 2, 20).splits]) {
    for (const tr of sp.train) {
      for (const te of sp.test) {
        const a = spans[tr];
        const b = spans[te];
        assert.ok(a.t1 < b.t0 || a.t0 > b.t1 + 20 || a.t1 < b.t0, `overlap train ${tr} test ${te}`);
      }
    }
  }
  assert.equal(cpcv(spans, 6, 2, 0).splits.length, 15);
  assert.equal(cpcv(spans, 6, 2, 0).nPaths, 5);
});

test('triple barrier: profit target, stop and vertical barrier', () => {
  const mk = (closes: number[]): Bar[] => closes.map((c, i) => ({ key: 'K', ts: i * 60_000, open: c, high: c, low: c, close: c, volume: 1 }));
  const up = tripleBarrier(mk([100, 101, 102, 103]), [{ index: 0, side: 1, sigma: 0.01 }], 2, 1, 10);
  assert.equal(up[0].barrier, 'pt');
  assert.equal(up[0].meta, 1);
  const dn = tripleBarrier(mk([100, 99.5, 98.9]), [{ index: 0, side: 1, sigma: 0.01 }], 2, 1, 10);
  assert.equal(dn[0].barrier, 'sl');
  assert.equal(dn[0].meta, 0);
  const flat = tripleBarrier(mk([100, 100.1, 100.2]), [{ index: 0, side: -1, sigma: 0.01 }], 2, 1, 2);
  assert.equal(flat[0].barrier, 'vertical');
  assert.equal(flat[0].meta, 0);
});

test('meta-label model learns a separable signal; bet size is monotone', () => {
  const g = gaussian(41);
  const X = [];
  const y: (0 | 1)[] = [];
  for (let i = 0; i < 600; i++) {
    const s = g();
    X.push({ strength: s, rvol: g() });
    y.push(s + 0.3 * g() > 0 ? 1 : 0);
  }
  const m = trainMetaModel(X, y);
  assert.ok(predictMeta(m, { strength: 2 }) > 0.8);
  assert.ok(predictMeta(m, { strength: -2 }) < 0.2);
  assert.equal(betSize(0.5), 0);
  assert.ok(betSize(0.9) >= betSize(0.7));
});

test('drift monitors: PSI/KS flag a shifted distribution; Page–Hinkley flags decay', () => {
  const g = gaussian(51);
  const ref = Array.from({ length: 2000 }, g);
  const same = Array.from({ length: 2000 }, g);
  const shifted = Array.from({ length: 2000 }, () => g() + 1);
  assert.ok(psi(ref, same) < 0.1);
  assert.ok(psi(ref, shifted) > 0.25);
  assert.ok(ks2(ref, same).p > 0.01);
  assert.ok(ks2(ref, shifted).p < 1e-6);
  const ph = new PageHinkley(0.01, 5);
  for (let i = 0; i < 200; i++) ph.update(0.1 + g() * 0.05);
  let alarm = false;
  for (let i = 0; i < 200; i++) alarm = ph.update(-0.1 + g() * 0.05) || alarm;
  assert.ok(alarm);
  const decay = checkDecay(Array.from({ length: 60 }, () => -0.002 + g() * 0.001), 0.3, 0.002, 30, 0.5, gaussian(1));
  assert.equal(decay.demote, true);
});

test('gates require every check to pass', () => {
  assert.equal(evaluateGates({ expectancyAfterCosts: 10, dsr: 0.97, pbo: 0.1, sharpeDoubledSlippage: 0.05 }).passed, true);
  assert.equal(evaluateGates({ expectancyAfterCosts: 10, dsr: 0.9, pbo: 0.1, sharpeDoubledSlippage: 0.05 }).passed, false);
  assert.equal(evaluateGates({ expectancyAfterCosts: 10, dsr: 0.97, pbo: undefined, sharpeDoubledSlippage: 0.05 }).passed, false);
});

test('isotonic calibration is monotone and improves Brier on over-confident scores', () => {
  const pts = [];
  for (let i = 0; i < 1000; i++) {
    const x = (i % 100) / 100;
    pts.push({ x, y: (i * 7919) % 100 < x * 60 ? 1 : 0 }); // true hit rate = 0.6x
  }
  const m = fitIsotonic(pts);
  for (let i = 1; i < m.ys.length; i++) assert.ok(m.ys[i] >= m.ys[i - 1]);
  assert.ok(m.brierAfter! < m.brierBefore!);
  assert.ok(Math.abs(applyIsotonic(m, 0.9) - 0.54) < 0.1);
});
