import { createContext, useContext } from 'react'

/** Provided by the Thread: scroll a section that starts revealing into view above the composer (unless the user scrolled away). */
export const FollowContext = createContext<((el: HTMLElement) => void) | undefined>(undefined)
export const useFollow = () => useContext(FollowContext)
