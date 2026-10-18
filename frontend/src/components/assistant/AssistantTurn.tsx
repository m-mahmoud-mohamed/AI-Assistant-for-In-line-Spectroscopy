import './assistant.css'
import { useEffect, type ReactNode } from 'react'
import { CircleAlert, OctagonX } from 'lucide-react'
import { skipAnswers } from '../../assistant/answers'
import { isTurnRunning, isTurnTerminal, type TurnItem } from '../../assistant/turnReducer'
import { useTurn } from '../../hooks/useTurn'
import { BlurIn } from '../../motion'
import type { Assessment } from '../../state/useAssessment'
import { ApprovalCard } from './ApprovalCard'
import { AssistantMessage } from './AssistantMessage'
import { QuestionCard } from './QuestionCard'
import { Suggestions } from './Suggestions'
import { ProgressBlock } from './ProgressBlock'
import { runSteps, turnSteps, withRun } from './progressSteps'

interface AssistantTurnProps {
  turnId: string
  assessment: Assessment
  /** The newest turn of the thread: only its suggestions and open cards take the keyboard. */
  latest: boolean
}

/**
 * One assistant turn in the conversation column, built from its event stream: the plan checklist, tool activity rows,
 * the streamed message with citation chips, the question and approval cards the turn pauses on, the report run it
 * started, and clickable next steps.
 */
export function AssistantTurn({ turnId, assessment: a, latest }: AssistantTurnProps) {
  const turn = useTurn(turnId)
  const { state } = turn
  const running = isTurnRunning(state)
  const terminal = isTurnTerminal(state.status)

  // What the rest of the app needs from this turn: its verdict (the report pane's preview), the run it started, whether
  // it is running (the composer's Stop button) and a way to stop it.
  const { onTurnVerdict, onTurnReport, onTurnRunning, registerTurnStop } = a
  useEffect(() => {
    if (state.verdict) onTurnVerdict(turnId, state.verdict)
  }, [state.verdict, turnId, onTurnVerdict])
  const reportRun = state.report?.runId
  useEffect(() => {
    if (reportRun) onTurnReport(turnId, reportRun)
  }, [reportRun, turnId, onTurnReport])
  useEffect(() => {
    onTurnRunning(turnId, running)
    return () => onTurnRunning(turnId, false)
  }, [running, turnId, onTurnRunning])
  const stop = turn.stop
  useEffect(() => {
    registerTurnStop(turnId, stop)
    return () => registerTurnStop(turnId, null)
  }, [turnId, stop, registerTurnStop])

  const nodes: ReactNode[] = []
  const last = state.items.length - 1
  state.items.forEach((item: TurnItem, i) => {
    if (item.kind === 'tool') {
      return
    }
    if (item.kind === 'text') {
      nodes.push(
        <AssistantMessage
          key={item.id}
          text={item.text}
          streaming={running && i === last}
          citations={i === last || state.message === item.text ? state.citations : {}}
          onCite={a.cite}
          webSources={i === last || state.message === item.text ? state.webSources : []}
        />,
      )
    } else if (item.kind === 'question') {
      const q = item.question
      nodes.push(
        <BlurIn key={item.id} duration={250} y={6} blur={4}>
          <QuestionCard
            title={q.title}
            questions={q.questions}
            verdict={state.verdict}
            resolved={q.resolved || terminal}
            answers={q.answers}
            busy={turn.busy}
            error={turn.actionError}
            autoFocus={latest && running && !q.resolved}
            onApply={(answers) => void turn.answer(q.questionId, answers)}
            onSkip={() => void turn.answer(q.questionId, skipAnswers(q.questions))}
          />
        </BlurIn>,
      )
    } else {
      const ap = item.approval
      nodes.push(
        <BlurIn key={item.id} duration={250} y={6} blur={4}>
          <ApprovalCard
            label={ap.label}
            why={ap.why}
            costCalls={ap.costCalls}
            resolved={ap.resolved || terminal}
            decision={ap.decision}
            busy={turn.busy}
            error={turn.actionError}
            autoFocus={latest && running && !ap.resolved}
            onApprove={() => void turn.approve(ap.approvalId, true)}
            onSkip={() => void turn.approve(ap.approvalId, false)}
          />
        </BlurIn>,
      )
    }
  })

  return (
    <div className="as-turn" role="region" aria-label="Assistant" data-status={state.status}>
      <ProgressBlock steps={withRun(turnSteps(state, turn.events), state.report?.runId === a.activeRunId ? runSteps(a.run.state) : [])} status={state.status} completedLabel={state.report ? `Wrote report v${state.report.version ?? 1}` : undefined} />
      {nodes}
      {state.report && <button className="link-btn" onClick={() => { a.openRun(state.report!.runId); a.setPane('report') }}>Open report{state.report.version !== null ? ` v${state.report.version}` : ''}</button>}
      {state.status === 'failed' && (
        <p role="alert" className="inline-error">
          <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" /> {state.error}
        </p>
      )}
      {state.status === 'stopped' && (
        <p className="as-stopped">
          <OctagonX size={15} strokeWidth={1.75} aria-hidden="true" /> Stopped. Ask again or pick up where it left off.
        </p>
      )}
      {turn.connection === 'error' && !terminal && <p className="rs-muted">Lost the connection to the assistant.</p>}
      {latest && state.suggestions.length > 0 && !running && state.status !== 'failed' && (
        <BlurIn duration={250} y={4} blur={3}>
          <Suggestions options={state.suggestions} onPick={a.runSuggestion} disabled={a.sending} />
        </BlurIn>
      )}
    </div>
  )
}

