import type { VoicePhase } from "../../hooks/useAlfredVoice";
import { WaveformVisualizer } from "./WaveformVisualizer";

const LABELS: Record<VoicePhase, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  "using-tool": "Using tool",
  "needs-approval": "Needs approval",
  speaking: "Speaking",
  done: "Done",
  error: "Error",
};

export function VoiceOverlay({
  activeRequestId,
  audioElement,
  error,
  finalTranscript,
  interimTranscript,
  onApprove,
  onInterrupt,
  onStart,
  phase,
  responseText,
  supported,
  canApprove,
}: {
  activeRequestId: string | null;
  audioElement: HTMLAudioElement | null;
  error: string | null;
  finalTranscript: string;
  interimTranscript: string;
  onApprove: () => void;
  onInterrupt: () => void;
  onStart: () => void;
  phase: VoicePhase;
  responseText: string;
  supported: boolean;
  canApprove: boolean;
}) {
  const active = phase !== "idle" && phase !== "done" && phase !== "error";
  const waveformMode = phase === "listening" ? "microphone" : phase === "speaking" ? "playback" : "idle";

  return (
    <section className="panel voice-overlay" aria-label="Browser voice mode">
      <div className="voice-overlay__heading">
        <div><span className="eyebrow">Browser voice</span><h2>{LABELS[phase]}</h2></div>
        <span className={`voice-state voice-state--${phase}`} aria-live="polite">{LABELS[phase]}</span>
      </div>
      <WaveformVisualizer audioElement={audioElement} mode={waveformMode} />
      {!supported ? <p className="error-text" role="alert">Browser speech recognition is unavailable here. Wispr Flow remains available through the desktop listener.</p> : <p className="voice-privacy">Browser recognition is an MVP fallback and may use your browser vendor’s remote speech service. Wispr Flow remains the primary desktop listener.</p>}
      <div className="voice-transcript" aria-live="polite">
        <span className="eyebrow">You</span>
        <p>{interimTranscript || finalTranscript || "Click the microphone and speak naturally."}</p>
        {interimTranscript ? <small>Interim transcript</small> : null}
      </div>
      {responseText ? <div className="voice-response"><span className="eyebrow">Alfred</span><p>{responseText}</p></div> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {activeRequestId ? <code className="request-id">{activeRequestId}</code> : null}
      <div className="button-row voice-actions">
        <button className="button button--primary voice-mic" disabled={!supported || active} onClick={onStart} type="button">{phase === "done" || phase === "error" ? "Speak again" : "Start microphone"}</button>
        {canApprove ? <button className="button button--primary" onClick={onApprove} type="button">Approve action</button> : null}
        <button className="button button--danger" disabled={!active} onClick={onInterrupt} type="button">Interrupt</button>
      </div>
    </section>
  );
}
