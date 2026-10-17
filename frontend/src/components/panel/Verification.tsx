import { Check, X } from 'lucide-react'
import type { Verification } from '../../types'
import './panel.css'

const pct = (n: number) => `${Math.round(n <= 1 ? n * 100 : n)}%`

/** [label when passed, label when failed] for each deterministic check the backend runs on a web source. */
const CHECKS: { key: string; ok: (v: Verification) => string; bad: (v: Verification) => string }[] = [
  { key: 'reachable', ok: () => 'Source page reachable', bad: () => 'Source page not reachable' },
  {
    key: 'quote_found',
    ok: (v) => `Quote found in the page (${v.match_kind} match, score ${pct(v.match_score)})`,
    bad: () => 'Quote not found in the page',
  },
  { key: 'domain_allowed', ok: () => 'Domain is on the allowed list', bad: () => 'Domain is not allowed' },
  { key: 'metadata_consistent', ok: () => 'Title matches the page', bad: () => 'Title does not match the page' },
  { key: 'quote_length', ok: () => 'Quote length within limits', bad: () => 'Quote length outside limits' },
  { key: 'claim_numbers_in_quote', ok: () => 'Numbers in the claim appear in the quote', bad: () => 'Claim has numbers the quote does not contain' },
  { key: 'no_injection_markers', ok: () => 'No prompt-injection markers', bad: () => 'Prompt-injection markers found' },
]

const humanize = (k: string) => k.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())

/** The verification checklist of a web source: one small pass / fail row per check, then any notes. */
export function VerificationChecklist({ verification: v }: { verification: Verification }) {
  const known = new Set(CHECKS.map((c) => c.key))
  const rows = [
    ...CHECKS.filter((c) => c.key in v.checks).map((c) => ({ key: c.key, pass: v.checks[c.key], text: v.checks[c.key] ? c.ok(v) : c.bad(v) })),
    ...Object.keys(v.checks)
      .filter((k) => !known.has(k))
      .map((k) => ({ key: k, pass: v.checks[k], text: humanize(k) })),
  ]
  return (
    <div className="vc-wrap">
      <ul className="vc" aria-label="Verification checks">
        {rows.map((r) => (
          <li key={r.key} data-pass={r.pass}>
            <span className="vc-icon" aria-hidden="true">
              {r.pass ? <Check size={11} strokeWidth={3} /> : <X size={11} strokeWidth={3} />}
            </span>
            <span className="sr-only">{r.pass ? 'Passed: ' : 'Failed: '}</span>
            {r.text}
          </li>
        ))}
      </ul>
      {v.notes.length > 0 && (
        <ul className="vc-notes">
          {v.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
