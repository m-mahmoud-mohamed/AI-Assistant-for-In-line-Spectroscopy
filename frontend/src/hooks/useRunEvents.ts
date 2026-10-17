// Subscribes to a run's SSE stream (`GET /api/runs/{id}/events`) and folds it into a PipelineState.
//
// Reconnect-safe: the server replays stored events on every connection, and the reducer drops any
// event whose `seq` it has already applied. When the browser gives up on a connection
// (readyState CLOSED) we reopen it with exponential backoff. The stream is closed on a terminal event.
import { useEffect, useReducer, useState } from 'react'
import { parseRunEvent, runEventsUrl } from '../api'
import { applyEvent, applyEvents, initialPipelineState, type PipelineState } from '../pipeline/reducer'
import { TERMINAL_EVENTS, type RunEvent, type RunEventType } from '../types'

export type Connection = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error'

type Action = { kind: 'reset'; runId: string | null; events?: RunEvent[] } | { kind: 'event'; event: RunEvent }

function reduce(state: PipelineState, action: Action): PipelineState {
  if (action.kind === 'reset') return applyEvents(action.events ?? [], initialPipelineState(action.runId))
  return applyEvent(state, action.event)
}

const EVENT_TYPES: RunEventType[] = [
  'stage_started',
  'stage_completed',
  'rule_fired',
  'evidence_selected',
  'issue_found',
  'repaired',
  ...TERMINAL_EVENTS,
]
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 15_000
const MAX_RETRIES = 8

export interface RunEventsResult {
  state: PipelineState
  connection: Connection
}

export function useRunEvents(runId: string | null): RunEventsResult {
  const [state, dispatch] = useReducer(reduce, runId, initialPipelineState)
  const [connection, setConnection] = useState<Connection>(runId ? 'connecting' : 'idle')
  const [trackedRunId, setTrackedRunId] = useState(runId)

  // Reset synchronously when the run changes (React's "adjust state during render" pattern).
  if (trackedRunId !== runId) {
    setTrackedRunId(runId)
    dispatch({ kind: 'reset', runId })
    setConnection(runId ? 'connecting' : 'idle')
  }

  useEffect(() => {
    if (!runId || typeof EventSource === 'undefined') return
    let source: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let retries = 0
    let done = false

    const onData = (e: MessageEvent) => {
      let event: RunEvent
      try {
        event = parseRunEvent(String(e.data))
      } catch {
        return // malformed frame (e.g. a keep-alive comment relayed as data)
      }
      retries = 0
      dispatch({ kind: 'event', event })
      if (TERMINAL_EVENTS.includes(event.type)) {
        done = true
        source?.close()
        setConnection('closed')
      }
    }

    const connect = () => {
      const es = new EventSource(runEventsUrl(runId))
      source = es
      es.onopen = () => setConnection('open')
      es.onmessage = onData
      // sse-starlette may send named events (`event: stage_started`); listen for those as well.
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
  }, [runId])

  return { state, connection }
}
