import { CircleHelp } from 'lucide-react'
import { slotLabel } from '../../labels'
import type { Unknown } from '../../types'

interface UnknownGroupsProps {
  groups: [string, Unknown[]][]
  /** Stream name for an unknown (only when the enquiry has several streams). */
  streamName: (id: string | null) => string | null
}

/** Key unknowns as dashed "?" chips; a reason that covers several of them is stated once, above its chips. */
export function UnknownGroups({ groups, streamName }: UnknownGroupsProps) {
  return (
    <div className="rs-unk">
      {groups.map(([why, items]) => (
        <div key={why} className="rs-unk-group">
          <p className="rs-p rs-unk-why">{why.replace(/\.$/, '') + ':'}</p>
          <ul className="unk-chips">
            {items.map((u, i) => (
              <li key={i}>
                <span className="rs-unknown">
                  <CircleHelp size={12} strokeWidth={2} aria-hidden="true" />
                  {slotLabel(u.slot)}
                  {streamName(u.stream_id) && <span className="rs-stream-note"> · {streamName(u.stream_id)}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
