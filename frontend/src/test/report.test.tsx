import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ClaimText } from '../components/report/ClaimText'
import { PlanTimeline } from '../components/report/PlanTimeline'
import { QuestionsList } from '../components/report/QuestionsList'
import { ReportView } from '../components/report/ReportView'
import { StatusBanner } from '../components/report/StatusBanner'
import mockReport from '../mock/report.json'
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
    expect(screen.getAllByRole('listitem', { name: /^Step / })).toHaveLength(plan.steps.length)
    expect(screen.getByRole('region', { name: 'Go / no-go' })).toHaveTextContent('to be agreed with client')
  })

  it('ReportView switches tabs and opens a cited source', () => {
    render(
      <ReportView
        report={{
          ...report,
          sources: [
            {
              id: 'S01-p17-nir-reflection-opaque',
              citation: 'S01 p.17',
              quote: 'Verbatim quote.',
              scope: 'method_general',
              url: null,
            },
          ],
        }}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tab')).toHaveLength(10)

    fireEvent.click(screen.getByRole('button', { name: 'Show source S01 p.17' }))
    expect(screen.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true')
    const panel = screen.getByRole('tabpanel')
    expect(within(panel).getByText('Verbatim quote.')).toBeInTheDocument()
    expect(within(panel).getByText('Method (general)')).toBeInTheDocument()
  })
})
