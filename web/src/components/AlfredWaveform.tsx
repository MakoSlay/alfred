export function AlfredWaveform({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "waveform waveform--compact" : "waveform"} aria-label="Alfred is ready">
      {Array.from({ length: 11 }, (_, index) => <span key={index} />)}
    </div>
  );
}
