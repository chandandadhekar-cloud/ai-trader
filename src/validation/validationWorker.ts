// Worker-thread entry for validation runs (keeps the trading loop responsive).
import { parentPort, workerData } from 'node:worker_threads';
import { validatedRun, type ValidatedRunInput } from './validatedRun.ts';

process.env.NODE_ENV = 'test'; // silence per-module stdout logging inside the worker
validatedRun(workerData as ValidatedRunInput)
  .then((result) => parentPort!.postMessage({ ok: true, result: JSON.parse(JSON.stringify(result, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v))) }))
  .catch((e) => parentPort!.postMessage({ ok: false, error: String((e as Error)?.message ?? e) }));
