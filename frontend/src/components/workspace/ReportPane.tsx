import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { TAB_IDS, TAB_LABEL, type TabId } from '../../state/tabs'
import type { Assessment } from '../../state/useAssessment'
import type { RawReport } from '../../reportData'
import { ExpandAllContext } from '../report/expandAll'
import { buildReportModel } from './model'
import { PendingPane } from './PendingPane'
import { ReportHeader } from './ReportHeader'
import { TabBar, type TabSpec } from './TabBar'
import { ChecksTab } from './tabs/ChecksTab'
import { ConceptTab } from './tabs/ConceptTab'
import { EvidenceTab } from './tabs/EvidenceTab'
import { MethodsTab } from './tabs/MethodsTab'
import { OverviewTab } from './tabs/OverviewTab'
import { PlanTab } from './tabs/PlanTab'
import { QuestionsTab } from './tabs/QuestionsTab'
import { SpectralTab } from './tabs/SpectralTab'

/** Runs whose reveal already played: reopening a session never replays it. */
const revealed = new Set<string>()

/** Height of the sticky title bar (px); the tab bar sticks below it. Keep in sync with `--rh-bar-h` in workspace.css. */
const BAR_H = 60

interface ReportPaneProps {
  assessment: Assessment
  /** The pane is on screen (below 1180 px only one pane shows): the number keys switch tabs only then. */
  visible: boolean
}

/** The right pane: the report workspace once there is a report, else the skeleton with the live run, a refusal or a failure. */
export function ReportPane({ assessment: a, visible }: ReportPaneProps) {
  if (a.reportRaw && !a.refusal) return <ReportWorkspace key={a.reportKey} assessment={a} report={a.reportRaw} visible={visible} />
  return <PendingPane assessment={a} />
}

function ReportWorkspace({ assessment: a, report, visible }: ReportPaneProps & { report: RawReport }) {
  const { rules, tab, setTab, reportKey } = a
  // Before the run exists (the assistant's clarify step) the report is already being awaited: its sections show skeletons.
  const runStatus = a.run.state.status === 'idle' && a.reportPartial ? 'running' : a.run.state.status
  const spectralMethods = a.enginePreview?.spectral_methods
  // `view` is the report with any absent section filled empty; `model.pending` says which ones were absent
  const model = useMemo(() => buildReportModel(report, rules, runStatus, spectralMethods), [report, rules, runStatus, spectralMethods])
  const view = model.view
  const scroller = useRef<HTMLElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  // Decided once, when the report first appears (as the engine's early result, or whole): one that has not revealed yet.
  const [reveal] = useState(() => (a.freshRun || a.reportPartial) && !revealed.has(reportKey))
  useEffect(() => {
    if (reveal) revealed.add(reportKey)
  }, [reveal, reportKey])
  // Tabs cross-fade (opacity only) after the first switch; the first paint never animates.
  const [switched, setSwitched] = useState(false)

  // Print / PDF: every tab, in order, with the tab bar hidden and every disclosure open.
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

  const select = useCallback(
    (next: TabId) => {
      if (next === tab) return
      setSwitched(true)
      setTab(next)
      // a deep scroll in the old tab must not hide the top of the new one: rest just under the sticky bars
      const sc = scroller.current
      const bars = tabsRef.current
      if (sc && bars) {
        const rest = Math.max(0, bars.offsetTop - BAR_H)
        if (sc.scrollTop > rest) sc.scrollTop = rest
      }
    },
    [tab, setTab],
  )

  // 1–8 switch tabs unless focus is in a text field, a menu or a dialog.
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return
      const i = '12345678'.indexOf(e.key)
      if (e.key.length !== 1 || i < 0) return
      const target = e.target as HTMLElement | null
      if (target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="combobox"], [role="menu"]')) return
      if (document.querySelector('[aria-modal="true"]')) return
      select(TAB_IDS[i])
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, select])

  const specs: TabSpec[] = TAB_IDS.map((id) => {
    // a count shows only once its section is in the report
    const p = model.pending
    const count: Partial<Record<TabId, number | string>> = {
      methods: p.candidates && p.recs ? 0 : model.candidates.length || model.recs.length,
      spectral: p.ranges ? 0 : view.spectral_ranges.length,
      plan: p.plan ? 0 : view.feasibility_plan.steps.length,
      questions: p.questions ? 0 : model.questions.length,
      evidence: p.sources ? 0 : model.sources.length,
      checks: p.compliance ? 0 : model.compliance.length ? `${model.passed}/${model.compliance.length}` : 0,
    }
    return {
      id,
      label: TAB_LABEL[id],
      count: count[id] || undefined,
      tone: id === 'checks' && model.passed < model.compliance.length ? 'bad' : undefined,
    }
  })

  const props = { assessment: a, report: view, rules, model }
  const body = (id: TabId) => {
    switch (id) {
      case 'overview':
        return <OverviewTab {...props} reveal={reveal} />
      case 'methods':
        return <MethodsTab {...props} />
      case 'spectral':
        return <SpectralTab {...props} />
      case 'concept':
        return <ConceptTab {...props} />
      case 'plan':
        return <PlanTab {...props} />
      case 'questions':
        return <QuestionsTab {...props} />
      case 'evidence':
        return <EvidenceTab {...props} />
      case 'checks':
        return <ChecksTab {...props} />
    }
  }
  const shown: readonly TabId[] = printing ? TAB_IDS : [tab]

  return (
    <ExpandAllContext.Provider value={printing}>
      <section ref={scroller} className="rp" aria-label="Assessment report" data-testid="report-pane">
        <ReportHeader assessment={a} report={view} model={model} reveal={reveal} />
        <div ref={tabsRef} className="rtabs" data-print-hide>
          <div className="rp-w">
            <TabBar tabs={specs} active={tab} onSelect={select} />
          </div>
        </div>
        <div className="rp-w tp-wrap">
          {shown.map((id) => (
            <div
              key={id}
              role="tabpanel"
              id={`tabpanel-${id}`}
              aria-labelledby={`tab-${id}`}
              tabIndex={0}
              className="tp"
              data-fade={switched && !printing ? 'true' : undefined}
            >
              {printing && <h2 className="tp-print-title">{TAB_LABEL[id]}</h2>}
              {body(id)}
            </div>
          ))}
        </div>
      </section>
    </ExpandAllContext.Provider>
  )
}
