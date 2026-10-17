// The report as one flowing, Lumeo-style answer: status and verdict pills with the direct answer, then
// bold-labelled sections with bullets. No tabs; long sections have a "Show more" disclosure.
import { Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { CircleCheck, CircleHelp, CircleX } from 'lucide-react'
import { MethodHeatmap } from '../../charts/MethodHeatmap'
import { clientFiberFrom } from '../../charts/spectral'
import { SpectralWindowChart } from '../../charts/SpectralWindowChart'
import { scoreMatrix } from '../../charts/scores'
import { checkLabel, slotLabel } from '../../labels'
import type { AssessmentReport, ReportBody, RuleFindings, SpectralData } from '../../types'
import '../thread/thread.css'
import { ClaimChip, ClaimText } from './ClaimText'
import { DirectAnswer } from './DirectAnswer'
import { Disclosure, DisclosureRow, MoreList } from './Disclosure'
import { PlanTimeline } from './PlanTimeline'
import { PremiseChecks } from './PremiseChecks'
import { QuestionsList } from './QuestionsList'
import { RecommendationItem } from './Recommendations'
import { sortedRecommendations } from './recommendations'
import { Rv } from './reveal'
import { ExpandAllContext, RevealContext, REVEAL, SectionStartContext, revealDuration, useRevealDelay } from './revealState'

/** A full AssessmentReport, or just the LLM body with whatever metadata is available. */
export type ReportViewData = ReportBody & Partial<Omit<AssessmentReport, keyof ReportBody>>

export interface ReportViewProps {
  report: ReportViewData
  /** Opens the evidence viewer for a card (citation chips). Without it the chips are plain labels. */
  onCite?: (cardId: string) => void
  /** Method, fiber and instrument ranges (`GET /api/kb/spectral`) for the spectral window chart. */
  spectral?: SpectralData
  /** Rule-engine output for this run: candidate scores (method comparison) and fiber-window findings. */
  rules?: RuleFindings
  /** A fresh report: reveal it word by word. Stored reports render at once. */
  reveal?: boolean
  /** Called with a section when it starts revealing (the thread scrolls it into view). */
  onRevealSection?: (el: HTMLElement) => void
  /** Delay (ms) before the reveal starts (the Sources row goes first). */
  revealDelay?: number
  /** Called when the reveal has finished. */
  onRevealDone?: () => void
}

const humanise = (slot: string) => slot.replaceAll('_', ' ')

interface SectionProps {
  id: string
  label: string
  index: number
  /** A collapsed section: one line (label + summary) that opens on demand. */
  row?: { summary: string; defaultOpen: boolean }
  children: ReactNode
}

/** One labelled section; starts revealing 120 ms after the previous one. A `row` section sits behind a disclosure. */
function Section({ id, label, index, row, children }: SectionProps) {
  const ref = useRef<HTMLElement>(null)
  const { follow, base = 0 } = useContext(RevealContext)
  const delay = useRevealDelay(0)
  const start = index * REVEAL.sectionStagger
  const active = delay !== null
  useEffect(() => {
    if (!active || !follow || row) return
    const t = setTimeout(() => ref.current && follow(ref.current), base + start)
    return () => clearTimeout(t)
  }, [active, follow, base, start, row])
  return (
    <SectionStartContext.Provider value={start}>
      <section ref={ref} aria-labelledby={id} className="rs-sec" data-row={row ? 'true' : undefined}>
        {row ? (
          <DisclosureRow id={id} label={<Rv>{label}</Rv>} summary={row.summary} defaultOpen={row.defaultOpen}>
            {children}
          </DisclosureRow>
        ) : (
          <>
            <h3 id={id} className="rs-label">
              <Rv>{label}</Rv>
            </h3>
            {children}
          </>
        )}
      </section>
    </SectionStartContext.Provider>
  )
}

/** First `n` items joined, for one-line disclosure summaries. */
const list = (items: string[], n = 3) => items.slice(0, n).join(', ') + (items.length > n ? '…' : '')
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function ReportView({ report, onCite, spectral, rules, reveal = false, revealDelay = 0, onRevealSection, onRevealDone }: ReportViewProps) {
  // Print / PDF: open every disclosure (theme.css hides the app chrome).
  const [printing, setPrinting] = useState(false)
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true))
    const after = () => setPrinting(false)
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [])

  const sources = useMemo(() => report.sources ?? [], [report.sources])
  const citations = useMemo(() => Object.fromEntries(sources.map((s) => [s.id, s.citation])), [sources])
  const streams = useMemo(() => report.streams ?? [], [report.streams])
  const streamNames = useMemo(() => Object.fromEntries(streams.map((s) => [s.id, s.name])), [streams])
  // A stream is named only when the enquiry has two or more; a single "main" stream is not worth a label.
  const multiStream = streams.length >= 2
  const streamName = (id: string | null) => (multiStream && id ? (streamNames[id] ?? id) : null)
  const claim = { onCite, citations }

  // Chart rows: the rule engine's candidate methods, else the recommended methods.
  const chartMethods = useMemo(() => {
    const ids = rules?.candidates.length ? rules.candidates.map((c) => c.method) : report.recommendations.flatMap((r) => r.methods)
    return [...new Set(ids)]
  }, [rules, report.recommendations])

  const recs = sortedRecommendations(report.recommendations)
  const facts = report.requirements.stated_facts
  const unknowns = report.requirements.key_unknowns
  const interpretations = report.interpretations ?? []
  const withLimitations = recs.filter((r) => r.limitations.length > 0)
  const compliance = Object.entries(report.compliance ?? {})
  const passed = compliance.filter(([, ok]) => ok).length
  const matrixRows = useMemo(() => scoreMatrix(rules?.candidates ?? []).rows, [rules])
  const premiseOpen = report.premise_checks.some((p) => p.verdict !== 'SUPPORTED')

  // Unknowns that share a reason show it once, above the list that shares it.
  const unknownGroups = useMemo(() => {
    const by = new Map<string, typeof unknowns>()
    for (const u of unknowns) by.set(u.why_it_matters, [...(by.get(u.why_it_matters) ?? []), u])
    return [...by.entries()]
  }, [unknowns])

  // Sections in reading order; empty ones are left out. Open ones lead, the rest sit behind one-line rows.
  const sections: { id: string; label: string; node: ReactNode; row?: { summary: string; defaultOpen: boolean } }[] = []
  const add = (id: string, label: string, node: ReactNode, show = true, summary?: string, defaultOpen = false) => {
    if (show) sections.push({ id, label, node, row: summary === undefined ? undefined : { summary, defaultOpen } })
  }

  add(
    'rs-recs',
    'Recommendations',
    <MoreList
      items={recs.map((r, i) => (
        <RecommendationItem key={i} rec={r} index={i} streams={streams} {...claim} />
      ))}
      limit={3}
      noun="recommendations"
    />,
    recs.length > 0,
  )

  const premiseCount = (v: string) => report.premise_checks.filter((p) => p.verdict === v).length
  add(
    'rs-premises',
    'Premise checks',
    <PremiseChecks checks={report.premise_checks} {...claim} />,
    report.premise_checks.length > 0,
    // a contradicted or unverifiable premise changes the decision: that row opens by itself
    [
      premiseCount('CONTRADICTED') > 0 && `${premiseCount('CONTRADICTED')} contradicted`,
      premiseCount('UNVERIFIABLE') > 0 && `${premiseCount('UNVERIFIABLE')} unverifiable`,
      premiseCount('SUPPORTED') > 0 && `${premiseCount('SUPPORTED')} supported`,
    ]
      .filter(Boolean)
      .join(' · '),
    premiseOpen,
  )

  add('rs-plan', 'Feasibility plan', <PlanTimeline plan={report.feasibility_plan} {...claim} />)

  add(
    'rs-questions',
    'Questions for the client',
    <QuestionsList questions={report.clarification_questions} initial={3} />,
    report.clarification_questions.length > 0,
  )

  add(
    'rs-concept',
    'Measurement concept',
    <ul className="rs-list">
      {report.measurement_concept.map((m, i) => (
        <li key={i}>
          {streamName(m.stream_id) && <strong className="rs-strong">{streamName(m.stream_id)}</strong>}
          <dl className="rs-dl">
            <dt>Probe geometry</dt>
            <dd>
              <Rv item={i}>{m.probe_geometry}</Rv>
            </dd>
            <dt>Location</dt>
            <dd>
              <Rv item={i}>{m.location}</Rv>
            </dd>
            <dt>Fiber link</dt>
            <dd>
              <Rv item={i}>{m.fiber_link}</Rv>
            </dd>
          </dl>
          <ClaimText segments={m.notes} item={i + 1} {...claim} />
        </li>
      ))}
    </ul>,
    report.measurement_concept.length > 0,
    report.measurement_concept[0] ? `${report.measurement_concept[0].probe_geometry} · ${report.measurement_concept[0].location}` : '',
  )

  add(
    'rs-spectral',
    'Spectral windows',
    <>
      {spectral && (
        <SpectralWindowChart data={spectral} methods={chartMethods} clientFiber={clientFiberFrom(rules?.findings)} findings={rules?.findings} onCite={onCite} />
      )}
      {report.spectral_ranges.length > 0 && (
        <MoreList
          items={report.spectral_ranges.map((s, i) => (
            <li key={i}>
              <strong className="rs-strong">{s.method}</strong>
              <dl className="rs-dl">
                <dt>Nominal range</dt>
                <dd className="mono">{s.nominal_range}</dd>
                {s.excitation_nm && (
                  <>
                    <dt>Excitation</dt>
                    <dd className="mono">{s.excitation_nm} nm</dd>
                  </>
                )}
                <dt>Fiber family needed</dt>
                <dd>{s.fiber_family_needed}</dd>
              </dl>
              <ClaimText segments={s.caveat} {...claim} />
            </li>
          ))}
          limit={3}
          noun="spectral ranges"
        />
      )}
    </>,
    !!spectral || report.spectral_ranges.length > 0,
    report.spectral_ranges.length > 0 ? report.spectral_ranges.map((s) => (s.nominal_range.toLowerCase().startsWith(s.method.toLowerCase()) ? s.nominal_range : `${s.method} ${s.nominal_range}`)).join(', ') : 'Method ranges against fiber transmission',
  )

  add(
    'rs-compare',
    'Method comparison',
    <MethodHeatmap candidates={rules?.candidates ?? []} streamNames={streamNames} {...claim} />,
    !!rules && rules.candidates.length > 0,
    matrixRows[0] ? `${plural(matrixRows.length, 'candidate')} · highest: ${matrixRows[0].label}` : '',
  )

  add(
    'rs-facts',
    'What the client told us',
    facts.length === 0 ? (
      <p className="rs-muted">No facts extracted yet.</p>
    ) : (
      <MoreList
        items={facts.map((f, i) => (
          <li key={i}>
            <strong className="rs-strong">{slotLabel(f.slot)}:</strong> <Rv item={i}>{humanise(f.value)}</Rv>
            {streamName(f.stream_id) && <span className="rs-stream-note"> {streamName(f.stream_id)}</span>}
            <span className="rs-quote">
              <ClaimChip type="CLIENT" />“{f.quote}”
            </span>
          </li>
        ))}
        limit={4}
        noun="facts"
      />
    ),
    true,
    facts.length === 0 ? 'Nothing extracted yet' : `${plural(facts.length, 'fact')} · ${list(facts.map((f) => humanise(f.value)))}`,
  )

  add(
    'rs-unknowns',
    'Key unknowns',
    <div className="rs-unk">
      {unknownGroups.map(([why, items], g) => (
        <div key={why} className="rs-unk-group">
          <p className="rs-p rs-unk-why">
            <Rv item={g}>{why.replace(/\.$/, '') + ':'}</Rv>
          </p>
          <ul className="rs-list">
            {items.map((u, i) => (
              <li key={i}>
                <span className="rs-unknown">
                  <CircleHelp size={12} strokeWidth={2} aria-hidden="true" />
                  {slotLabel(u.slot)}
                </span>
                {streamName(u.stream_id) && <span className="rs-stream-note"> {streamName(u.stream_id)}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>,
    unknowns.length > 0,
    `${plural(unknowns.length, 'open item')} · ${list(unknowns.map((u) => slotLabel(u.slot)))}`,
  )

  add(
    'rs-terms',
    'How we read your terms',
    <MoreList
      items={interpretations.map((t, i) => (
        <li key={i}>
          “{t.term}” read as <strong className="rs-strong">{t.canonical ?? 'not resolved'}</strong>{' '}
          <span className="rs-mono-note">
            ({t.kind}, {t.how})
          </span>
          {t.ambiguous && (
            <span className="pill pill-warn" style={{ marginLeft: 8 }}>
              <CircleHelp size={12} strokeWidth={2} aria-hidden="true" />
              Ambiguous
            </span>
          )}
          {t.alternatives.length > 0 && <span className="rs-muted-inline"> alternatives: {t.alternatives.join(', ')}</span>}
        </li>
      ))}
      limit={3}
      noun="terms"
    />,
    interpretations.length > 0,
    list(
      interpretations.map((t) => `“${t.term}” → ${t.canonical ?? 'unresolved'}`),
      2,
    ),
  )

  add(
    'rs-risks',
    'Risks & assumptions',
    <>
      {report.risks.length > 0 && (
        <div className="rs-sub">
          <span className="rs-sub-label">Risks</span>
          <MoreList
            items={report.risks.map((r, i) => (
              <li key={i}>
                <ClaimText segments={r.risk} item={i} {...claim} />
                <p className="rs-p">
                  <span className="rs-muted-inline">Effect:</span> {r.effect}
                </p>
                <p className="rs-p">
                  <span className="rs-muted-inline">Mitigation:</span> {r.mitigation}
                </p>
              </li>
            ))}
            limit={3}
            noun="risks"
          />
        </div>
      )}
      {report.assumptions.length > 0 && (
        <div className="rs-sub">
          <span className="rs-sub-label">Assumptions</span>
          <MoreList
            items={report.assumptions.map((a, i) => (
              <li key={i}>
                <ClaimChip type="ASSUMPTION" />
                <Rv item={i}>{a.assumption}</Rv> <span className="rs-muted-inline">· confirm with {a.to_confirm_with}</span>
              </li>
            ))}
            limit={4}
            noun="assumptions"
          />
        </div>
      )}
    </>,
    report.risks.length > 0 || report.assumptions.length > 0,
    [report.risks.length > 0 && plural(report.risks.length, 'risk'), report.assumptions.length > 0 && plural(report.assumptions.length, 'assumption')]
      .filter(Boolean)
      .join(' · '),
  )

  add(
    'rs-limits',
    'Limitations',
    <ul className="rs-list">
      {withLimitations.map((r, i) => (
        <li key={i}>
          <strong className="rs-strong">
            {r.methods.join(' + ')} · {r.technique}
          </strong>
          <ClaimText segments={r.limitations} item={i} {...claim} />
        </li>
      ))}
    </ul>,
    withLimitations.length > 0,
    `${plural(withLimitations.length, 'method')} with caveats · ${list(
      withLimitations.map((r) => r.methods.join(' + ')),
      2,
    )}`,
  )

  add('rs-basis', 'Decision basis', <ClaimText segments={report.decision_basis} {...claim} />, report.decision_basis.length > 0, report.decision_basis[0]?.text ?? '')

  // Open sections lead, the one-line rows follow together.
  const openSections = sections.filter((s) => !s.row || s.row.defaultOpen)
  const rowSections = sections.filter((s) => s.row && !s.row.defaultOpen)

  const total = sections.length + 1 // the lead (status and direct answer) comes first
  // The reveal is over a little after the last section's words; the parent stops its spinner then.
  const doneRef = useRef(onRevealDone)
  useEffect(() => {
    doneRef.current = onRevealDone
  })
  useEffect(() => {
    if (!reveal) return
    const t = setTimeout(() => doneRef.current?.(), revealDelay + revealDuration(total) + 200)
    return () => clearTimeout(t)
  }, [reveal, revealDelay, total])

  const runRows: [string, string | undefined][] = [
    ['Case', report.case_id],
    ['Run', report.run_id],
    ['Created', report.created_at],
    ['Profile', report.profile],
    ['KB version', report.kb_version],
    ['Input SHA-256', report.input_sha256],
  ]

  return (
    <ExpandAllContext.Provider value={printing}>
      <RevealContext.Provider value={{ enabled: reveal, follow: onRevealSection, base: revealDelay }}>
        <article className="rs" aria-label="Assessment report" data-reveal={reveal ? 'true' : undefined}>
          <SectionStartContext.Provider value={0}>
            <DirectAnswer answer={report.direct_answer} status={report.decision_status} {...claim} />
          </SectionStartContext.Provider>
          {openSections.map((s, i) => (
            <Section key={s.id} id={s.id} label={s.label} index={i + 1} row={s.row}>
              {s.node}
            </Section>
          ))}
          {rowSections.length > 0 && (
            <div className="rs-rows">
              {rowSections.map((s, i) => (
                <Section key={s.id} id={s.id} label={s.label} index={openSections.length + i + 1} row={s.row}>
                  {s.node}
                </Section>
              ))}
            </div>
          )}

          {(compliance.length > 0 || report.run_id) && (
            <footer className="rs-foot">
              {compliance.length > 0 && (
                <Disclosure
                  variant="toggle"
                  label={
                    <span className="rs-checks" data-ok={passed === compliance.length ? 'true' : 'false'}>
                      Checks: {passed}/{compliance.length} passed
                    </span>
                  }
                >
                  <ul className="rs-list rs-compliance">
                    {compliance.map(([check, ok]) => (
                      <li key={check}>
                        {ok ? (
                          <CircleCheck size={14} aria-hidden="true" style={{ color: 'var(--status-ok)' }} />
                        ) : (
                          <CircleX size={14} aria-hidden="true" style={{ color: 'var(--status-bad)' }} />
                        )}
                        <strong className="rs-strong">{ok ? 'Pass' : 'Fail'}</strong>
                        <span>{checkLabel(check)}</span>
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
              {report.run_id && (
                <Disclosure variant="toggle" label="Run details">
                  <dl className="rs-dl rs-run">
                    {runRows.map(([k, v]) => (
                      <Fragment key={k}>
                        <dt>{k}</dt>
                        <dd className="mono">{v ?? '—'}</dd>
                      </Fragment>
                    ))}
                    {Object.entries(report.model_ids ?? {}).map(([role, model]) => (
                      <Fragment key={`m-${role}`}>
                        <dt>Model · {role}</dt>
                        <dd className="mono">{model}</dd>
                      </Fragment>
                    ))}
                    {Object.entries(report.prompt_hashes ?? {}).map(([name, hash]) => (
                      <Fragment key={`p-${name}`}>
                        <dt>Prompt · {name}</dt>
                        <dd className="mono">{hash}</dd>
                      </Fragment>
                    ))}
                  </dl>
                </Disclosure>
              )}
            </footer>
          )}
        </article>
      </RevealContext.Provider>
    </ExpandAllContext.Provider>
  )
}
