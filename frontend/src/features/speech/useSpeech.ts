import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { API_BASE } from '../../api'

export type SpeechPhase = 'idle' | 'requesting' | 'recording' | 'transcribing'
export type SpeechLanguage = 'auto' | 'en' | 'ar'
const MAX_MS = 120_000
const TIMEOUT_MS = 65_000
const MAX_BYTES = 20 * 1024 * 1024

/** Every recording owns its tracks, timers and upload. Cancellation invalidates late permission/upload results. */
export function useSpeech(onText: (text: string) => void) {
  const [phase, setPhase] = useState<SpeechPhase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const phaseRef = useRef<SpeechPhase>('idle')
  const generation = useRef(0)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const upload = useRef<AbortController | null>(null)
  const interval = useRef<ReturnType<typeof setInterval> | null>(null)
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null)
  const insert = useRef(onText)
  useLayoutEffect(() => { insert.current = onText }, [onText])
  const transition = useCallback((next: SpeechPhase) => { phaseRef.current = next; setPhase(next) }, [])
  const release = useCallback(() => {
    if (interval.current) clearInterval(interval.current)
    if (deadline.current) clearTimeout(deadline.current)
    interval.current = null
    deadline.current = null
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
  }, [])
  const cancel = useCallback(() => {
    generation.current += 1
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
    recorder.current = null
    upload.current?.abort()
    upload.current = null
    release()
    transition('idle')
  }, [release, transition])
  useEffect(() => () => {
    generation.current += 1
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
    upload.current?.abort()
    release()
  }, [release])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && phaseRef.current !== 'idle') { event.preventDefault(); cancel() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [cancel])

  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') {
      transition('transcribing')
      recorder.current.stop()
      release()
    }
  }, [release, transition])

  const start = useCallback(async (language: SpeechLanguage) => {
    if (phaseRef.current !== 'idle') return
    setError(null)
    setElapsed(0)
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('Voice recording is not supported in this browser. Use a browser with microphone access over HTTPS or localhost.')
      return
    }
    const token = ++generation.current
    transition('requesting')
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (generation.current !== token) { media.getTracks().forEach((track) => track.stop()); return }
      stream.current = media
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type))
      const rec = new MediaRecorder(media, mime ? { mimeType: mime } : undefined)
      recorder.current = rec
      const chunks: Blob[] = []
      let bytes = 0
      rec.ondataavailable = (event) => {
        if (generation.current !== token || !event.data.size) return
        bytes += event.data.size
        if (bytes > MAX_BYTES) {
          cancel()
          setError('The recording is too large. Please record a shorter message (20 MB maximum).')
        } else chunks.push(event.data)
      }
      rec.onerror = () => {
        if (generation.current !== token) return
        cancel()
        setError('The microphone stopped unexpectedly. Please try recording again.')
      }
      rec.onstop = async () => {
        if (generation.current !== token) return
        release()
        transition('transcribing')
        const controller = new AbortController()
        upload.current = controller
        let timedOut = false
        const timeout = setTimeout(() => { timedOut = true; controller.abort() }, TIMEOUT_MS)
        try {
          const audio = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' })
          if (!audio.size) throw new Error('The recording was empty. Please try again.')
          const body = new FormData()
          body.append('audio', audio, 'recording')
          body.append('language', language)
          const response = await fetch(`${API_BASE}/speech/transcribe`, { method: 'POST', body, signal: controller.signal })
          if (!response.ok) {
            const result = await response.json().catch(() => null)
            throw new Error(typeof result?.detail === 'string' ? result.detail : 'Transcription failed. Please try again.')
          }
          const result = await response.json()
          if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('No speech was detected. Please try again.')
          if (generation.current === token) insert.current(result.text)
        } catch (err) {
          if (generation.current === token) setError(timedOut ? 'Transcription timed out. Try a shorter recording.' : err instanceof Error && err.name !== 'TypeError' ? err.message : 'Could not transcribe the recording. Check your connection and try again.')
        } finally {
          clearTimeout(timeout)
          if (generation.current === token) { upload.current = null; recorder.current = null; transition('idle') }
        }
      }
      rec.start(1000)
      transition('recording')
      const started = Date.now()
      interval.current = setInterval(() => setElapsed(Math.min(120, Math.floor((Date.now() - started) / 1000))), 1000)
      deadline.current = setTimeout(stop, MAX_MS)
    } catch (err) {
      if (generation.current !== token) return
      release()
      transition('idle')
      const name = err instanceof Error ? err.name : ''
      setError(name === 'NotAllowedError' || name === 'SecurityError' ? 'Microphone permission was denied. Allow microphone access in your browser and try again.' : name === 'NotFoundError' ? 'No microphone was found. Connect a microphone and try again.' : 'Could not start recording. Check that your microphone is connected and available.')
    }
  }, [cancel, release, stop, transition])
  return { phase, elapsed, error, start, stop, cancel }
}
