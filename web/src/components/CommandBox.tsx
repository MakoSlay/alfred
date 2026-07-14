import { useState, type FormEvent } from "react";

export function CommandBox({ onSubmit, busy = false, initialValue = "" }: {
  onSubmit: (text: string) => Promise<void> | void;
  busy?: boolean;
  initialValue?: string;
}) {
  const [text, setText] = useState(initialValue);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    await onSubmit(value);
    setText("");
  }

  return (
    <form className="command-box" onSubmit={submit}>
      <label className="sr-only" htmlFor="alfred-command">Ask Alfred</label>
      <input
        id="alfred-command"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Ask Alfred…"
        autoComplete="off"
      />
      <button className="button button--primary" disabled={busy || !text.trim()} type="submit">
        {busy ? "Working…" : "Send"}
      </button>
    </form>
  );
}
