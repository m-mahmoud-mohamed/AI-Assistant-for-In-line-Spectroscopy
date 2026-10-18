// Subscribes to an assistant turn's SSE stream (`GET /api/turns/{id}/events`, CONTRACTS C4) and folds it into a TurnState.
//
// Reconnect-safe like useRunEvents: the server replays stored events on every connection, the reducer drops any event whose
// `seq` it has already applied, a connection the browser gave up on is reopened with backoff, and the stream is closed on a
// terminal event. Also offers the three things a scientist can do to a turn: answer its question, decide its approval, stop it.
import { useCallback, useEffect, useReducer, useState } from 'react'
import { api, parseTurnEvent, turnEventsUrl } from '../api'
import { initialTurnState, turnReducer, type TurnState } from '../assistant/turnReducer'
import type { QuestionAnswer, TurnEvent, TurnEventType } from '../types'
import type { Connection } from './useRunEvents'

const EVENT_TYPES: TurnEventType[] = [
  'message_delta',
  'plan',
  'tool_started',
  'tool_finished',
  'question',
  'approval',
  'verdict',
  'report',
  'suggestions',
  'turn_completed',
  'turn_failed',
]
const TERMINAL: readonly TurnEventType[] = ['turn_completed', 'turn_failed']
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 15_000
const MAX_RETRIES = 8

export interface TurnResult {
  state: TurnState
  connection: Connection
  /** An answer / approval / stop request is in flight. */
  busy: boolean
  /** The last such request failed (the card stays open so the scientist can try again). */
  actionError: string | null
  answer: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>
  approve: (approvalId: string, approved: boolean) => Promise<void>
  stop: () => Promise<void>
}

type Dispatch = (action: Parameters<typeof turnReducer>[1]) => void

export function useTurn(turnId: string | null): TurnResult {
  const [state, dispatch] = useReducer(turnReducer, turnId, (id: string | null) => initialTurnState(id, id !== null))
  const [connection, setConnection] = useState<Connection>(turnId ? 'connecting' : 'idle')
  const [trackedId, setTrackedId] = useState(turnId)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // Reset synchronously when the turn changes (React's "adjust state during render" pattern).
  if (trackedId !== turnId) {
    setTrackedId(turnId)
    dispatch({ kind: 'reset', turnId })
    setConnection(turnId ? 'connecting' : 'idle')
  }

  useEffect(() => {
    if (!turnId || typeof EventSource === 'undefined') return
    let source: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let retries = 0
    let done = false

    const onData = (e: MessageEvent) => {
      let event: TurnEvent
      try {
        event = parseTurnEvent(String(e.data))
      } catch {
        return // malformed frame (e.g. a keep-alive comment relayed as data)
      }
      retries = 0
      dispatch({ kind: 'event', event })
      if (TERMINAL.includes(event.type)) {
        done = true
        source?.close()
        setConnection('closed')
      }
    }

    const connect = () => {
      const es = new EventSource(turnEventsUrl(turnId))
      source = es
      es.onopen = () => setConnection('open')
      es.onmessage = onData
      // sse-starlette may send named events (`event: plan`); listen for those as well.
      for (const type of EVENT_TYPES) es.addEventListener(type, onData as EventListener)
      es.onerror = () => {
        if (done) return
        if (es.readyState !== 2 /* CLOSED */) {
          setConnection('reconnecting') // the browser retries on its own
          return
        }
        es.close()
        if (retries >= MAX_RETRIES) {
          setConnection('error')
          return
        }
        setConnection('reconnecting')
        const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retries)
        retries += 1
        timer = setTimeout(connect, delay)
      }
    }

    connect()
    return () => {
      done = true
      clearTimeout(timer)
      source?.close()
    }
  }, [turnId])

  const act = useCallback(
    async (call: () => Promise<unknown>, onOk: (d: Dispatch) => void) => {
      setBusy(true)
      setActionError(null)
      try {
        await call()
        onOk(dispatch)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'The request failed.')
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const answer = useCallback(
    (questionId: string, answers: Record<string, QuestionAnswer>) =>
      turnId ? act(() => api.answerTurn(turnId, questionId, answers), (d) => d({ kind: 'answered', questionId, answers })) : Promise.resolve(),
    [turnId, act],
  )
  const approve = useCallback(
    (approvalId: string, approved: boolean) =>
      turnId ? act(() => api.approveTurn(turnId, approvalId, approved), (d) => d({ kind: 'decided', approvalId, approved })) : Promise.resolve(),
    [turnId, act],
  )
  const stop = useCallback(
    () => (turnId ? act(() => api.stopTurn(turnId), (d) => d({ kind: 'stopped' })) : Promise.resolve()),
    [turnId, act],
  )

  return { state, connection, busy, actionError, answer, approve, stop }
}
