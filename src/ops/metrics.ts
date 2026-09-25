// Minimal Prometheus text-format registry (plan §P2.14). Exposed at /metrics.

type Labels = Record<string, string>;

interface Series {
  help: string;
  type: 'gauge' | 'counter';
  values: Map<string, { labels: Labels; value: number }>;
}

export class Metrics {
  private series = new Map<string, Series>();

  private s(name: string, help: string, type: Series['type']): Series {
    let x = this.series.get(name);
    if (!x) this.series.set(name, (x = { help, type, values: new Map() }));
    return x;
  }

  private key(l: Labels): string {
    return Object.keys(l).sort().map((k) => `${k}=${l[k]}`).join(',');
  }

  gauge(name: string, help: string, value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) return;
    this.s(name, help, 'gauge').values.set(this.key(labels), { labels, value });
  }

  inc(name: string, help: string, by = 1, labels: Labels = {}): void {
    const s = this.s(name, help, 'counter');
    const k = this.key(labels);
    const cur = s.values.get(k);
    s.values.set(k, { labels, value: (cur?.value ?? 0) + by });
  }

  render(): string {
    const out: string[] = [];
    for (const [name, s] of this.series) {
      out.push(`# HELP ${name} ${s.help}`, `# TYPE ${name} ${s.type}`);
      for (const { labels, value } of s.values.values()) {
        const l = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`).join(',');
        out.push(`${name}${l ? `{${l}}` : ''} ${value}`);
      }
    }
    return out.join('\n') + '\n';
  }
}
