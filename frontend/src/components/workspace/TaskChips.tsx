import type { SuggestedTask, TaskAction } from '../../suggestions'

interface TaskChipsProps {
  tasks: SuggestedTask[]
  onRun: (action: TaskAction) => void
}

/** Suggested tasks as chips above the docked composer: they run an action or fill the composer, never send. */
export function TaskChips({ tasks, onRun }: TaskChipsProps) {
  if (tasks.length === 0) return null
  return (
    <div role="group" aria-label="Suggested tasks" className="task-chips" data-print-hide>
      {tasks.map((t) => (
        <button key={t.id} type="button" className="chip" onClick={() => onRun(t.action)}>
          {t.label.replaceAll('e-mail', 'e‑mail')}
        </button>
      ))}
    </div>
  )
}
