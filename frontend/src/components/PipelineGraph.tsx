import { memo, useMemo, useSyncExternalStore } from 'react'
import { Background, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { PipelineState, StageState } from '../pipeline/reducer'
import { STAGE_LABELS } from '../pipeline/reducer'
import { NODE_STATUS, formatSeconds, stageCounts, stagesRun } from '../pipeline/status'
import type { Stage } from '../types'

import './panel/panel.css'

interface PipelineGraphProps {
  state: PipelineState
  /** `full`: React Flow graph. `strip`: compact one-line strip shown above the report. */
  variant?: 'full' | 'strip'
  selected?: Stage | null
  onSelect?: (stage: Stage) => void
}

const MAX_LISTED = 4

// ---------------------------------------------------------------- shared bits

function StatusBadge({ st, compact = false }: { st: StageState; compact?: boolean }) {
  const { label, icon: Icon } = NODE_STATUS[st.status]
  return (
    <span className="pg-badge" data-status={st.status}>
      <Icon size={compact ? 12 : 14} strokeWidth={2} aria-hidden="true" className={st.status === 'running' ? 'spin' : undefined} />
      {label}
    </span>
  )
}

function Meta({ st }: { st: StageState }) {
  const parts = [formatSeconds(st.seconds), ...stageCounts(st)].filter(Boolean)
  if (parts.length === 0) return null
  return <span className="pg-meta tabular">{parts.join(' · ')}</span>
}

// ---------------------------------------------------------------- React Flow node

type StageNodeData = {
  st: StageState
  selected: boolean
  onSelect?: (stage: Stage) => void
  targetPos: Position
  sourcePos: Position
  first: boolean
  last: boolean
}
type StageNode = Node<StageNodeData, 'stage'>

const StageNodeView = memo(function StageNodeView({ data }: NodeProps<StageNode>) {
  const { st, selected, onSelect, targetPos, sourcePos, first, last } = data
  const listed =
    st.stage === 'rules'
      ? st.rules.map((r) => ({ id: r.rule_id, text: r.message, sev: r.severity }))
      : st.stage === 'verify'
        ? st.issues.map((i) => ({ id: i.check_id, text: i.message, sev: i.severity }))
        : []
  return (
    <div className="pg-node" data-status={st.status} data-selected={selected || undefined}>
      {!first && <Handle type="target" position={targetPos} isConnectable={false} />}
      <button
        type="button"
        className="nodrag pg-node-btn"
        onClick={() => onSelect?.(st.stage)}
        aria-label={`${STAGE_LABELS[st.stage]}: ${NODE_STATUS[st.status].label}. Show details`}
      >
        <span className="pg-node-name">{STAGE_LABELS[st.stage]}</span>
        <StatusBadge st={st} />
        <Meta st={st} />
      </button>
      {listed.length > 0 && (
        <ul className="pg-listed">
          {listed.slice(0, MAX_LISTED).map((item, i) => (
            <li key={i} title={`${item.id} (${item.sev}): ${item.text}`}>
              <span className="mono">{item.id}</span> <span>{item.sev}</span>
            </li>
          ))}
          {listed.length > MAX_LISTED && <li>+{listed.length - MAX_LISTED} more</li>}
        </ul>
      )}
      {!last && <Handle type="source" position={sourcePos} isConnectable={false} />}
    </div>
  )
})

const nodeTypes = { stage: StageNodeView }

// Snake layout: rows alternate left → right and right → left; two columns on a phone.
const COL_W = 206
const ROW_H = 168

function layout(i: number, perRow: number) {
  const row = Math.floor(i / perRow)
  const k = i % perRow
  const col = row % 2 === 0 ? k : perRow - 1 - k
  const endOfRow = k === perRow - 1
  const startOfRow = k === 0 && row > 0
  return {
    position: { x: col * COL_W, y: row * ROW_H },
    sourcePos: endOfRow ? Position.Bottom : row % 2 === 0 ? Position.Right : Position.Left,
    targetPos: startOfRow ? Position.Top : row % 2 === 0 ? Position.Left : Position.Right,
  }
}

const subscribeNarrow = (cb: () => void) => {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia('(max-width: 639px)')
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const isNarrow = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 639px)').matches

function FullGraph({ state, selected, onSelect }: Omit<PipelineGraphProps, 'variant'>) {
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false)
  const stages = useMemo(() => stagesRun(state), [state])
  const perRow = narrow ? 2 : 3

  const nodes = useMemo<StageNode[]>(
    () =>
      stages.map((stage, i) => {
        const { position, sourcePos, targetPos } = layout(i, perRow)
        return {
          id: stage,
          type: 'stage',
          position,
          data: { st: state.stages[stage], selected: selected === stage, onSelect, sourcePos, targetPos, first: i === 0, last: i === stages.length - 1 },
        }
      }),
    [stages, state.stages, selected, onSelect, perRow],
  )

  const edges = useMemo<Edge[]>(
    () =>
      stages.slice(1).map((stage, i) => {
        const from = state.stages[stages[i]]
        const to = state.stages[stage]
        const active = to.status === 'running'
        const reached = to.status !== 'idle' && from.status !== 'idle'
        return {
          id: `${stages[i]}-${stage}`,
          source: stages[i],
          target: stage,
          type: 'smoothstep',
          animated: active,
          style: { stroke: active ? '#6a42e0' : reached ? '#b8a5f3' : '#dcdfe8', strokeWidth: active ? 2 : 1.5 },
        }
      }),
    [stages, state.stages],
  )

  return (
    <div role="group" aria-label="Pipeline graph" className="pg-canvas">
      <ReactFlow
        key={`${stages.length}-${perRow}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_, node) => onSelect?.(node.id as Stage)}
        minZoom={0.3}
        maxZoom={1.5}
        style={{ background: 'transparent' }}
      >
        <Background color="#e3e5ee" gap={22} size={1.2} />
      </ReactFlow>
    </div>
  )
}

// ---------------------------------------------------------------- compact strip

function Strip({ state, selected, onSelect }: Omit<PipelineGraphProps, 'variant'>) {
  return (
    <ol aria-label="Pipeline stages" className="pg-strip">
      {stagesRun(state).map((stage) => {
        const st = state.stages[stage]
        return (
          <li key={stage}>
            <button type="button" onClick={() => onSelect?.(stage)} aria-current={selected === stage ? 'true' : undefined} data-status={st.status}>
              <span className="pg-node-name">{STAGE_LABELS[stage]}</span>
              <StatusBadge st={st} compact />
              <Meta st={st} />
            </button>
          </li>
        )
      })}
    </ol>
  )
}

/** Live pipeline graph: a pure projection of the run's SSE events (see pipeline/reducer.ts). */
export function PipelineGraph({ variant = 'full', ...props }: PipelineGraphProps) {
  return variant === 'strip' ? <Strip {...props} /> : <FullGraph {...props} />
}
