import { useEffect, useState } from "react";

const BAR_COUNT = 28;

export function WaveformVisualizer({ mode, audioElement }: {
  mode: "idle" | "microphone" | "playback";
  audioElement: HTMLAudioElement | null;
}) {
  const [levels, setLevels] = useState<number[]>(() => Array(BAR_COUNT).fill(0.12));

  useEffect(() => {
    if (mode === "idle" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setLevels(Array(BAR_COUNT).fill(0.12));
      return;
    }

    let cancelled = false;
    let frame = 0;
    let context: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let source: AudioNode | null = null;
    let analyser: AnalyserNode | null = null;

    async function start() {
      try {
        context = new AudioContext();
        analyser = context.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.76;
        if (mode === "microphone") {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (cancelled) {
            for (const track of stream.getTracks()) track.stop();
            if (context.state !== "closed") void context.close();
            return;
          }
          source = context.createMediaStreamSource(stream);
          source.connect(analyser);
        } else if (audioElement) {
          source = context.createMediaElementSource(audioElement);
          source.connect(analyser);
          analyser.connect(context.destination);
        } else {
          return;
        }
        const bins = new Uint8Array(analyser.frequencyBinCount);
        const draw = () => {
          if (cancelled || !analyser) return;
          analyser.getByteFrequencyData(bins);
          setLevels(Array.from({ length: BAR_COUNT }, (_, index) => {
            const value = bins[index % bins.length] ?? 0;
            return Math.max(0.08, value / 255);
          }));
          frame = requestAnimationFrame(draw);
        };
        draw();
      } catch {
        setLevels(Array(BAR_COUNT).fill(0.12));
      }
    }

    void start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      source?.disconnect();
      analyser?.disconnect();
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (context && context.state !== "closed") void context.close();
    };
  }, [audioElement, mode]);

  return (
    <div aria-hidden="true" className="live-waveform">
      {levels.map((level, index) => <span key={index} style={{ transform: `scaleY(${0.18 + level * 0.82})` }} />)}
    </div>
  );
}
