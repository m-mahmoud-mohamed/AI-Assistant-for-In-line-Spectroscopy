import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ClaimText } from '../components/report/ClaimText'
import { PlanTimeline } from '../components/report/PlanTimeline'
import { QuestionsList } from '../components/report/QuestionsList'
import { PremiseChecks } from '../components/report/PremiseChecks'
import { RecommendationItem } from '../components/report/Recommendations'
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

    // AFS is the unmarked default: its citation chip already names the source
    expect(screen.queryByText('AFS')).toBeNull()
    expect(document.querySelector('[data-claim="AFS"]')).toBeNull()
    expect(screen.getByText('Assumption')).toBeInTheDocument()
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.getByText('NIR reflection suits opaque products.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show source S01 p.17' }))
    expect(onCite).toHaveBeenCalledWith('S01-p17-nir-reflection-opaque')
    expect(onCite).toHaveBeenCalledTimes(1)
  })

  it('ClaimText reveals its words one by one only when asked', () => {
    const segments: Segment[] = [{ text: 'Two words', claim_type: 'PROPOSAL', evidence_ids: [] }]
    const { container, unmount } = render(<ClaimText segments={segments} />)
    expect(container.querySelector('.reveal-word')).toBeNull()
    unmount()
    const fresh = render(<ClaimText segments={segments} reveal={{ delay: 0 }} />)
    expect(fresh.container.querySelectorAll('.reveal-word')).toHaveLength(2)
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

  it('Questions: "Use as follow-up" hands the question to the caller; the compact list has neither the reason nor the action', () => {
    const questions: Question[] = [{ question: 'First?', priority: 1, decision_it_changes: 'fiber_link_choice', why_it_matters: 'It decides the interface.' }]
    const onUse = vi.fn()
    const { unmount } = render(<QuestionsList questions={questions} onUse={onUse} />)
    // a snake_case field from the backend reads as a sentence
    expect(screen.getByText('Changes: Fiber link choice')).toBeInTheDocument()
    expect(screen.getByText('It decides the interface.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use as follow-up: First?' }))
    expect(onUse).toHaveBeenCalledWith('First?')
    unmount()
    render(<QuestionsList questions={questions} onUse={onUse} compact />)
    expect(screen.queryByText('It decides the interface.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Use as follow-up/ })).toBeNull()
  })

  it('the plan shows every step, the clarify-first items and the client-agreement placeholder for go / no-go', () => {
    const plan: FeasibilityPlan = { ...report.feasibility_plan, go_no_go: [] }
    render(<PlanTimeline plan={plan} />)
    expect(screen.getAllByRole('listitem', { name: /^Step / })).toHaveLength(plan.steps.length)
    expect(screen.getByRole('region', { name: 'Clarify first' })).toHaveTextContent('acceptance criteria')
    expect(screen.getByRole('region', { name: 'References needed' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Go / no-go' })).toHaveTextContent('to be agreed with client')
  })

  it('premise checks: a contradicted or unverifiable premise is marked as a problem, a supported one is plain', () => {
    const checks = [
      { premise: 'Fat can be read through the pipe wall.', verdict: 'CONTRADICTED' as const, explanation: [] },
      { premise: 'The line runs continuously.', verdict: 'UNVERIFIABLE' as const, explanation: [] },
      { premise: 'Milk is opaque.', verdict: 'SUPPORTED' as const, explanation: [] },
    ]
    render(<PremiseChecks checks={checks} />)
    const items = screen.getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Contradicted')
    expect(items[0]).toHaveAttribute('data-problem', 'true')
    expect(items[1]).toHaveAttribute('data-problem', 'true')
    expect(items[2]).toHaveTextContent('Supported')
    expect(items[2]).not.toHaveAttribute('data-problem')
  })

  it('a recommendation shows role pill, evidence strength and its reasons; the summary stops at three and links to the rest', () => {
    const rec = { ...report.recommendations[0], evidence_strength: 'Strong' }
    const reasons = Array.from({ length: 5 }, (_, i) => ({ text: `Reason ${i + 1}.`, claim_type: 'AFS' as const, evidence_ids: ['S01-p17-nir-reflection-opaque'] }))
    const onMore = vi.fn()
    const onCite = vi.fn()
    const { unmount } = render(
      <RecommendationItem rec={{ ...rec, rationale: reasons, limitations: [] }} variant="summary" onMore={onMore} onCite={onCite} citations={{ 'S01-p17-nir-reflection-opaque': 'S01 p.17' }} />,
    )
    const item = screen.getByRole('listitem', { name: `${rec.methods.join(' + ')} recommendation` })
    expect(item).toHaveTextContent(rec.technique)
    expect(item).toHaveTextContent('Evidence: Strong')
    expect(item.querySelector('[data-role]')).not.toBeNull()
    expect(within(item).getAllByText(/^Reason \d\.$/)).toHaveLength(3)
    fireEvent.click(within(item).getAllByRole('button', { name: 'Show source S01 p.17' })[0])
    expect(onCite).toHaveBeenCalledWith('S01-p17-nir-reflection-opaque')
    fireEvent.click(within(item).getByRole('button', { name: '2 more in Methods' }))
    expect(onMore).toHaveBeenCalled()
    unmount()
    render(<RecommendationItem rec={{ ...rec, rationale: reasons, limitations: reasons.slice(0, 1) }} />)
    // the full variant lists every reason and the limitations
    expect(screen.getAllByText(/^Reason \d\.$/)).toHaveLength(6)
    expect(screen.getByText('Limitations')).toBeInTheDocument()
  })
})
