import { memo, useMemo } from 'react'
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { PipelineState, StageState } from '../pipeline/reducer'
import { STAGE_LABELS } from '../pipeline/reducer'
import { NODE_STATUS, formatSeconds, stageCounts } from '../pipeline/status'
import { STAGES, type Stage } from '../types'

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
  const { label, icon: Icon, color } = NODE_STATUS[st.status]
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold" data-status={st.status}>
      <Icon
        size={compact ? 12 : 14}
        aria-hidden="true"
        style={{ color }}
        className={st.status === 'running' ? 'motion-safe:animate-spin' : undefined}
      />
      {label}
    </span>
  )
}

function Meta({ st }: { st: StageState }) {
  const parts = [formatSeconds(st.seconds), ...stageCounts(st)].filter(Boolean)
  if (parts.length === 0) return null
  return <span className="font-mono text-[11px] text-muted">{parts.join(' · ')}</span>
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
  const { color } = NODE_STATUS[st.status]
  const listed =
    st.stage === 'rules'
      ? st.rules.map((r) => ({ id: r.rule_id, text: r.message, sev: r.severity }))
      : st.stage === 'verify'
        ? st.issues.map((i) => ({ id: i.check_id, text: i.message, sev: i.severity }))
        : []
  return (
    <div
      className={`w-[176px] rounded-lg border-2 bg-surface px-3 py-2 text-fg shadow-sm ${
        st.status === 'running' ? 'motion-safe:animate-pulse' : ''
      }`}
      style={{ borderColor: color, outline: selected ? '2px solid var(--focus-ring)' : undefined, outlineOffset: 2 }}
    >
      {!first && <Handle type="target" position={targetPos} isConnectable={false} />}
      <button
        type="button"
        className="nodrag flex w-full flex-col items-start gap-0.5 text-left"
        onClick={() => onSelect?.(st.stage)}
        aria-label={`${STAGE_LABELS[st.stage]}: ${NODE_STATUS[st.status].label}. Show details`}
      >
        <span className="text-sm font-bold">{STAGE_LABELS[st.stage]}</span>
        <StatusBadge st={st} />
        <Meta st={st} />
      </button>
      {listed.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 border-t border-line pt-1">
          {listed.slice(0, MAX_LISTED).map((item, i) => (
            <li key={i} className="truncate text-[11px]" title={`${item.id} (${item.sev}): ${item.text}`}>
              <span className="font-mono font-semibold">{item.id}</span> <span className="text-muted">{item.sev}</span>
            </li>
          ))}
          {listed.length > MAX_LISTED && <li className="text-[11px] text-muted">+{listed.length - MAX_LISTED} more</li>}
        </ul>
      )}
      {!last && <Handle type="source" position={sourcePos} isConnectable={false} />}
    </div>
  )
})

const nodeTypes = { stage: StageNodeView }

// Snake layout: first row left → right, second row right → left.
const ROW = 5
const COL_W = 210
const ROW_H = 190

function layout(i: number) {
  const row = Math.floor(i / ROW)
  const col = row === 0 ? i : ROW - 1 - (i - ROW)
  const endOfRow = i === ROW - 1
  const startOfRow = i === ROW
  return {
    position: { x: col * COL_W, y: row * ROW_H },
    sourcePos: endOfRow ? Position.Bottom : row === 0 ? Position.Right : Position.Left,
    targetPos: startOfRow ? Position.Top : row === 0 ? Position.Left : Position.Right,
  }
}

function FullGraph({ state, selected, onSelect }: Omit<PipelineGraphProps, 'variant'>) {
  const nodes = useMemo<StageNode[]>(
    () =>
      STAGES.map((stage, i) => {
        const { position, sourcePos, targetPos } = layout(i)
        return {
          id: stage,
          type: 'stage',
          position,
          data: {
            st: state.stages[stage],
            selected: selected === stage,
            onSelect,
            sourcePos,
            targetPos,
            first: i === 0,
            last: i === STAGES.length - 1,
          },
        }
      }),
    [state.stages, selected, onSelect],
  )

  const edges = useMemo<Edge[]>(
    () =>
      STAGES.slice(1).map((stage, i) => {
        const from = state.stages[STAGES[i]]
        const to = state.stages[stage]
        const active = to.status === 'running'
        const reached = to.status !== 'idle'
        return {
          id: `${STAGES[i]}-${stage}`,
          source: STAGES[i],
          target: stage,
          type: 'smoothstep',
          animated: active,
          style: {
            stroke: active ? 'var(--fiber-cyan)' : reached && from.status !== 'idle' ? 'var(--afs-prism-500)' : 'var(--border)',
            strokeWidth: 2,
          },
        }
      }),
    [state.stages],
  )

  return (
    <div role="group" aria-label="Pipeline graph" className="h-[440px] w-full rounded-lg border border-line bg-surface">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_, node) => onSelect?.(node.id as Stage)}
        minZoom={0.4}
        maxZoom={1.5}
        style={{ background: 'transparent' }}
      >
        <Background color="var(--border)" gap={20} />
      </ReactFlow>
    </div>
  )
}

// ---------------------------------------------------------------- compact strip

function Strip({ state, selected, onSelect }: Omit<PipelineGraphProps, 'variant'>) {
  return (
    <ol aria-label="Pipeline stages" className="flex gap-1 overflow-x-auto rounded-lg border border-line bg-surface p-1">
      {STAGES.map((stage) => {
        const st = state.stages[stage]
        const { color } = NODE_STATUS[st.status]
        return (
          <li key={stage} className="min-w-[92px] flex-1">
            <button
              type="button"
              onClick={() => onSelect?.(stage)}
              aria-current={selected === stage ? 'true' : undefined}
              className={`flex w-full flex-col items-start gap-0.5 rounded-md border-t-2 px-2 py-1 text-left hover:bg-surface-raised ${
                selected === stage ? 'bg-surface-raised' : ''
              }`}
              style={{ borderTopColor: color }}
            >
              <span className="text-xs font-bold">{STAGE_LABELS[stage]}</span>
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
