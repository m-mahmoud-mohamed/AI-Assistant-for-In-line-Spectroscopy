import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ClaimText } from '../components/report/ClaimText'
import { PlanTimeline } from '../components/report/PlanTimeline'
import { QuestionsList } from '../components/report/QuestionsList'
import { ReportView } from '../components/report/ReportView'
import { StatusBanner } from '../components/report/StatusBanner'
import mockReport from './fixtures/report.json'
import type { DecisionStatus, FeasibilityPlan, Question, ReportBody, Segment } from '../types'

const report = mockReport as ReportBody

describe('report view', () => {
  it('ClaimText shows label and calls onCite', () => {
    const onCite = vi.fn()
    const segments: Segment[] = [
      { text: 'NIR reflection suits opaque products.', claim_type: 'AFS', evidence_ids: ['S01-p17-nir-reflection-opaque'] },
      { text: 'Line runs continuously.', claim_type: 'ASSUMPTION', evidence_ids: [] },
      { text: 'Distance to analyzer.', claim_type: 'UNKNOWN', evidence_ids: [] },
    ]
    render(<ClaimText segments={segments} onCite={onCite} citations={{ 'S01-p17-nir-reflection-opaque': 'S01 p.17' }} />)

    expect(screen.getByText('AFS')).toBeInTheDocument()
    expect(screen.getByText('Assumption')).toBeInTheDocument()
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.getByText('NIR reflection suits opaque products.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show source S01 p.17' }))
    expect(onCite).toHaveBeenCalledWith('S01-p17-nir-reflection-opaque')
    expect(onCite).toHaveBeenCalledTimes(1)
  })

  it('StatusBanner text per status', () => {
    const expected: Record<DecisionStatus, string> = {
      PROVISIONAL: 'Provisional',
      INSUFFICIENT_INFORMATION: 'Insufficient information',
      OUTSIDE_SUPPORTED_SCOPE: 'Outside supported scope',
    }
    for (const [status, label] of Object.entries(expected)) {
      const { unmount } = render(<StatusBanner status={status as DecisionStatus} />)
      const banner = screen.getByRole('status')
      expect(banner).toHaveTextContent(`Status: ${label}`)
      expect(banner).toHaveAttribute('data-status', status)
      unmount()
    }
  })

  it('Questions sorted by priority with decision', () => {
    const questions: Question[] = [
      { question: 'Third?', priority: 3, decision_it_changes: 'fiber link', why_it_matters: 'c' },
      { question: 'First?', priority: 1, decision_it_changes: 'probe geometry', why_it_matters: 'a' },
      { question: 'Second?', priority: 2, decision_it_changes: 'method choice', why_it_matters: 'b' },
    ]
    render(<QuestionsList questions={questions} />)
    const items = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(items.map((li) => within(li).getByRole('heading').textContent)).toEqual(['First?', 'Second?', 'Third?'])
    expect(items[0]).toHaveTextContent('Changes: probe geometry')
    expect(items[2]).toHaveTextContent('Changes: fiber link')

    const { container } = render(<QuestionsList questions={questions} limit={2} />)
    expect(within(container).getAllByRole('listitem')).toHaveLength(2)
  })

  it('plan go/no-go shows the client-agreement placeholder', () => {
    const plan: FeasibilityPlan = { ...report.feasibility_plan, go_no_go: [] }
    render(<PlanTimeline plan={plan} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show plan details' }))
    expect(screen.getAllByRole('listitem', { name: /^Step / })).toHaveLength(plan.steps.length)
    expect(screen.getByRole('region', { name: 'Go / no-go' })).toHaveTextContent('to be agreed with client')
  })

  const sources = [
    { id: 'S01-p17-nir-reflection-opaque', citation: 'S01 p.17', quote: 'Verbatim quote.', scope: 'method_general' as const, url: null },
  ]

  it('ReportView is one flowing answer with no tabs and every section label', () => {
    render(<ReportView report={{ ...report, sources, compliance: { 'C-A': true, 'C-B': false } }} />)
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    const labels = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
      .filter((t) => t !== 'Direct answer')
    for (const label of ['Recommendations', 'Measurement concept', 'What the client told us', 'Feasibility plan', 'Questions for the client', 'Risks & assumptions']) {
      expect(labels).toContain(label)
    }
    // status pill + verdict pill + direct answer first
    expect(screen.getByRole('status')).toHaveTextContent(/Status: /)
    expect(screen.getByRole('region', { name: 'Direct answer' })).toBeInTheDocument()
    // compact checks line with an expandable compliance list
    const checks = screen.getByRole('button', { name: /Checks: 1\/2 passed/ })
    expect(screen.queryByText('C-B')).toBeNull()
    fireEvent.click(checks)
    expect(screen.getByText('C-B')).toBeInTheDocument()
  })

  it('lists premise checks with a verdict pill when the report has them', () => {
    const premise = { premise: 'Fat can be read through the pipe wall.', verdict: 'CONTRADICTED' as const, explanation: [] }
    render(<ReportView report={{ ...report, premise_checks: [premise] }} />)
    const section = screen.getByRole('region', { name: 'Premise checks' })
    expect(section).toHaveTextContent('Contradicted')
    expect(section).toHaveTextContent('Fat can be read through the pipe wall.')
  })

  it('shows recommendations with role pill, evidence strength and rationale', () => {
    render(<ReportView report={{ ...report, sources }} />)
    const rec = report.recommendations[0]
    const item = screen.getByRole('listitem', { name: `${rec.methods.join(' + ')} recommendation` })
    expect(item).toHaveTextContent(rec.technique)
    expect(item).toHaveTextContent(/Evidence:/)
    expect(item.querySelector('[data-role]')).not.toBeNull()
  })

  it('a citation chip calls onCite with the card id', () => {
    const onCite = vi.fn()
    render(<ReportView report={{ ...report, sources }} onCite={onCite} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Show source S01 p.17' })[0])
    expect(onCite).toHaveBeenCalledWith('S01-p17-nir-reflection-opaque')
  })

  it('renders instantly without a reveal by default, and with word spans while revealing', () => {
    const { container, unmount } = render(<ReportView report={{ ...report, sources }} />)
    expect(container.querySelector('.reveal-word')).toBeNull()
    unmount()
    const fresh = render(<ReportView report={{ ...report, sources }} reveal />)
    expect(fresh.container.querySelector('.reveal-word')).not.toBeNull()
  })

  it('a long section hides its extra items behind Show more', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ ...report.recommendations[0], technique: `probe-${i}` }))
    render(<ReportView report={{ ...report, recommendations: many }} />)
    expect(screen.queryByText('probe-5')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Show 3 more recommendations/ }))
    expect(screen.getByText(/probe-5/)).toBeInTheDocument()
  })
})
