import { useCallback, useEffect, useRef, useState } from "react";
import { alfredApi } from "../api/client";
import type { AlfredEvent } from "../api/types";

export type VoicePhase = "idle" | "listening" | "thinking" | "using-tool" | "needs-approval" | "speaking" | "done" | "error";

export function useAlfredVoice(latestEvent: AlfredEvent | null) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [responseText, setResponseText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [confirmationId, setConfirmationId] = useState<string | null>(null);

  const activeRequestRef = useRef<string | null>(null);
  const inactiveRequestsRef = useRef(new Set<string>());
  const abortRef = useRef<AbortController | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const submittedRef = useRef(false);
  const processedEventRef = useRef<AlfredEvent | null>(null);
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const supported = Boolean(Recognition);

  const isActive = useCallback((requestId: string) => (
    activeRequestRef.current === requestId && !inactiveRequestsRef.current.has(requestId)
  ), []);

  const clearAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    audioRef.current = null;
    setAudioElement(null);
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = null;
  }, []);

  const interrupt = useCallback(() => {
    const requestId = activeRequestRef.current;
    if (requestId) inactiveRequestsRef.current.add(requestId);
    abortRef.current?.abort();
    abortRef.current = null;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    clearAudio();
    activeRequestRef.current = null;
    setActiveRequestId(null);
    setConfirmationId(null);
    setInterimTranscript("");
    setPhase("idle");
    void alfredApi.stopVoice().catch(() => {});
  }, [clearAudio]);

  const submit = useCallback(async (text: string, requestId: string, pendingConfirmationId?: string) => {
    if (!text.trim() || !isActive(requestId)) return;
    setFinalTranscript(text.trim());
    setInterimTranscript("");
    setPhase("thinking");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await alfredApi.ask(text.trim(), requestId, {
        signal: controller.signal,
        playback: "browser",
        confirm: Boolean(pendingConfirmationId),
        confirmationId: pendingConfirmationId,
      });
      if (!isActive(requestId)) return;
      const displayText = response.displayText || response.speech || "Done.";
      setResponseText(displayText);
      if (response.requiresConfirmation) {
        setConfirmationId(response.confirmationId ?? null);
        setPhase("needs-approval");
        return;
      }
      setConfirmationId(null);
      if (!response.speech) {
        setPhase("done");
        return;
      }

      const synthesized = await alfredApi.synthesizeVoice(response.speech, requestId, controller.signal);
      if (!isActive(requestId)) return;
      clearAudio();
      const objectUrl = URL.createObjectURL(synthesized.audio);
      objectUrlRef.current = objectUrl;
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      setAudioElement(audio);
      audio.onended = () => {
        if (!isActive(requestId)) return;
        setPhase("done");
        clearAudio();
      };
      audio.onerror = () => {
        if (!isActive(requestId)) return;
        setError("Browser audio playback failed.");
        setPhase("error");
        clearAudio();
      };
      setPhase("speaking");
      await audio.play();
    } catch (cause) {
      if (!isActive(requestId) || (cause instanceof DOMException && cause.name === "AbortError")) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [clearAudio, isActive]);

  const approve = useCallback(() => {
    if (!confirmationId || !finalTranscript.trim()) return;
    const previousRequestId = activeRequestRef.current;
    if (previousRequestId) inactiveRequestsRef.current.add(previousRequestId);
    abortRef.current?.abort();
    clearAudio();
    const requestId = `req-${crypto.randomUUID()}`;
    activeRequestRef.current = requestId;
    setActiveRequestId(requestId);
    const pendingConfirmationId = confirmationId;
    setConfirmationId(null);
    setError(null);
    void submit(finalTranscript, requestId, pendingConfirmationId);
  }, [clearAudio, confirmationId, finalTranscript, submit]);

  const startListening = useCallback(() => {
    if (!Recognition) return;
    interrupt();
    const requestId = `req-${crypto.randomUUID()}`;
    inactiveRequestsRef.current.delete(requestId);
    activeRequestRef.current = requestId;
    setActiveRequestId(requestId);
    setInterimTranscript("");
    setFinalTranscript("");
    setResponseText("");
    setConfirmationId(null);
    setError(null);
    submittedRef.current = false;

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      if (!isActive(requestId)) return;
      let interim = "";
      let final = "";
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript ?? "";
        if (result?.isFinal) final += transcript;
        else interim += transcript;
      }
      setInterimTranscript(interim.trim());
      if (final.trim() && !submittedRef.current) {
        submittedRef.current = true;
        recognition.stop();
        void submit(final.trim(), requestId);
      }
    };
    recognition.onerror = (event) => {
      if (!isActive(requestId) || event.error === "aborted") return;
      setError(event.message || `Speech recognition failed: ${event.error}`);
      setPhase("error");
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      if (isActive(requestId) && !submittedRef.current) setPhase("idle");
    };
    recognitionRef.current = recognition;
    setPhase("listening");
    try {
      recognition.start();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    }
  }, [Recognition, interrupt, isActive, submit]);

  useEffect(() => {
    if (!latestEvent || processedEventRef.current === latestEvent) return;
    processedEventRef.current = latestEvent;
    if (!isActive(latestEvent.requestId)) return;
    switch (latestEvent.type) {
      case "ask:start": setPhase("thinking"); break;
      case "tool:start": setPhase("using-tool"); break;
      case "confirmation:created": setPhase("needs-approval"); break;
      case "speech:start": setPhase("speaking"); break;
      case "ask:done": setResponseText(latestEvent.displayText); break;
      case "ask:error":
      case "speech:error": setError(latestEvent.message); setPhase("error"); break;
      case "tool:done":
      case "speech:done": break;
    }
  }, [isActive, latestEvent]);

  useEffect(() => interrupt, [interrupt]);

  return {
    activeRequestId,
    audioElement,
    error,
    finalTranscript,
    interimTranscript,
    phase,
    responseText,
    supported,
    startListening,
    interrupt,
    approve,
    canApprove: Boolean(confirmationId),
  };
}
