// Local first-pass headline scoring (plan §D): cheap, instant, free. A compact
// finance lexicon (Loughran–McDonald style, extended with Indian market jargon).
// It is a placeholder for a local FinBERT/DeBERTa model; measure both against the
// hand-labelled Indian evaluation set before trusting either.

const POS = [
  'beat', 'beats', 'surge', 'record', 'order win', 'wins order', 'bags order', 'secures', 'bagged', 'buyback', 'upgrade', 'upgraded',
  'raises guidance', 'approval', 'approved', 'capacity expansion', 'acquires', 'dividend', 'bonus', 'profit jumps', 'profit rises',
  'strong', 'outperform', 'stake increase', 'block deal buy', 'usfda approval', 'eir clearance', 'l1 bidder', 'lowest bidder',
];
const NEG = [
  'miss', 'misses', 'plunge', 'penalty', 'fine', 'fraud', 'raid', 'probe', 'downgrade', 'downgraded', 'cuts guidance', 'loss widens',
  'profit falls', 'shutdown', 'plant shutdown', 'pledge', 'pledged', 'resigns', 'resignation', 'default', 'insolvency', 'ibc',
  'warning letter', 'import alert', 'observations', 'form 483', 'sebi order', 'gst notice', 'tax demand', 'weak', 'recall', 'strike',
];

export interface LexScore {
  score: number; // -1..1
  hits: string[];
}

export function lexiconScore(text: string): LexScore {
  const t = ` ${text.toLowerCase()} `;
  const hits: string[] = [];
  let p = 0;
  let n = 0;
  for (const w of POS) if (t.includes(` ${w}`)) { p++; hits.push(`+${w}`); }
  for (const w of NEG) if (t.includes(` ${w}`)) { n++; hits.push(`-${w}`); }
  const tot = p + n;
  return { score: tot === 0 ? 0 : (p - n) / tot, hits };
}
