import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { toolLabel } from '../assistant/format'
import { applyTurnEvent, initialTurnState } from '../assistant/turnReducer'
import { ProgressBlock } from '../components/assistant/ProgressBlock'
import { turnSteps } from '../components/assistant/progressSteps'
import { EngineCandidates } from '../components/workspace/EngineCandidates'
import { clientReportData, reportToMarkdown } from '../export'
import { completeReport, type RawReport } from '../reportData'
import type { TurnEvent } from '../types'
import fixture from './fixtures/report.json'

describe('client-facing report details', () => {
  it('keeps tool results and status in the progress disclosure without internal names or timings', () => {
    const events: TurnEvent[] = [
      { type: 'tool_started', turn_id: 't', seq: 0, ts: 1, payload: { call_id: 'c', tool: 'assess.prepare', label: 'Read the enquiry' } },
      { type: 'tool_finished', turn_id: 't', seq: 1, ts: 19, payload: { call_id: 'c', tool: 'assess.prepare', ms: 18000, ok: true, summary: '3 candidates' } },
      { type: 'turn_completed', turn_id: 't', seq: 2, ts: 20, payload: {} },
    ]
    const state = events.reduce(applyTurnEvent, initialTurnState('t'))
    const { container } = render(<ProgressBlock steps={turnSteps(state, events)} status={state.status} />)
    const toggle = screen.getByRole('button', { name: 'Analysis completed · 1 step' })
    fireEvent.click(toggle)
    const list = screen.getByRole('list', { name: 'Analysis steps' })
    expect(list).toHaveTextContent('Read the enquiryOK3 candidates')
    expect(container.textContent).not.toMatch(/assess\.prepare|18 s|19 s|20 s/)
  })

  it('uses connector titles and server names, including stored labels and ids with digests', () => {
    expect(toolLabel('mcp.Lab_server.search_docs_0123456789abcdef', 'Running Search documents on Lab server')).toBe('Lab server · Search documents')
    expect(toolLabel('mcp.Lab_server.search_docs_0123456789abcdef', 'mcp.Lab_server.search_docs_0123456789abcdef')).toBe('Lab server · search docs')
    expect(toolLabel('mcp.Lab.search_0123456789abcdef', 'Lab server · Search documents')).toBe('Lab server · Search documents')
    expect(toolLabel('kb.search', 'Searching AFS sources')).toBe('Searching AFS sources')
    expect(toolLabel('kb.search', 'kb.search')).toBe('kb search')
  })

  it('shows the engine order, status and available reasons in previews without scores', () => {
    render(<EngineCandidates engine={{ status: 'PROVISIONAL', questions: [], candidates: [
      { method: 'MIR', technique: 'ATR', score: 1.25, blocked: true, reasons: ['The link needs a different fiber.'] },
      { method: 'NIR', technique: 'Reflection', score: 99.75, blocked: false },
    ] }} />)
    const list = screen.getByRole('list', { name: 'Candidate methods from the rules engine' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('MIRATRBlockedThe link needs a different fiber.')
    expect(rows[1]).toHaveTextContent('NIRReflectionOpen')
    expect(list.textContent).not.toMatch(/1\.25|99\.75|score/i)
  })

  it('excludes stale run metadata and stated facts from local exports while retaining unknowns and source data', () => {
    const report = completeReport({ ...fixture, run_id: 'internal-run-id', profile: 'internal-profile',
      input_sha256: 'internal-input-hash', prompt_hashes: { writer: 'internal-prompt-hash' }, model_ids: { writer: 'internal-model' },
      findings: { candidates: [{ score: 999 }] },
      sources: [{ id: 'S01-example', citation: 'S01 p.1', quote: 'A cited passage.', scope: 'method_general', url: null }],
      version_info: { session_id: 'internal-session-id', version: 2, trigger: '', summary: '', changed_sections: [], follow_up_findings: [] },
      requirements: { stated_facts: [{ slot: 'targets', value: 'internal-fact-value', quote: 'internal-fact-quote', stream_id: null }],
        key_unknowns: [{ slot: 'response_time', stream_id: null, why_it_matters: 'Confirm the response time.' }] },
    } as unknown as RawReport)
    for (const text of [reportToMarkdown(report), JSON.stringify(clientReportData(report))]) {
      expect(text).toContain('Confirm the response time.')
      expect(text).not.toMatch(/internal-|stated_facts|What the client told us|Technical details/)
    }
    expect(reportToMarkdown(report)).toContain('Still unknown')
    expect(report.requirements.stated_facts).toHaveLength(1)
    expect(clientReportData(report)).toHaveProperty('sources', report.sources)
  })
})
