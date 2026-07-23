import { useCallback, useEffect, useState } from "react";
import { alfredApi } from "../api/client";
import type { NoteContent, NoteSummary } from "../api/types";

export function NotesPage() {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [directory, setDirectory] = useState("~/Documents/Alfred Notes");
  const [selected, setSelected] = useState<NoteContent | null>(null);
  const [status, setStatus] = useState("Loading notes…");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const result = await alfredApi.notes();
      setNotes(result.notes);
      setDirectory(result.directory);
      setStatus(result.notes.length ? `${result.notes.length} note${result.notes.length === 1 ? "" : "s"}.` : "No notes yet. Ask Alfred to save one.");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function view(filename: string) {
    setBusy(true);
    try {
      const note = await alfredApi.readNote(filename);
      setSelected(note);
      setStatus(`Viewing ${filename}.`);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function copy(filename: string) {
    setBusy(true);
    try {
      const note = await alfredApi.readNote(filename);
      await copyText(note.content);
      setStatus(`Copied ${filename} to the clipboard.`);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function open(filename?: string) {
    setBusy(true);
    try {
      const result = await alfredApi.openNote(filename);
      setStatus(result.kind === "folder" ? "Opened the Alfred Notes folder." : `Opened ${filename}.`);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="panel section-panel">
        <div className="section-heading">
          <div><span className="eyebrow">Your documents</span><h2>Alfred Notes</h2></div>
          <div className="button-row"><button className="button" disabled={busy} onClick={() => void refresh()} type="button">Refresh</button><button className="button button--primary" disabled={busy} onClick={() => void open()} type="button">Open folder</button></div>
        </div>
        <p>Ordinary Markdown and text files that belong to you. Open, edit, or copy them directly; Alfred can read them again when you reference a note.</p>
        <code className="session-chip" title={directory}>{directory}</code>
        <p aria-live="polite" role="status">{status}</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Note</th><th>Size</th><th>Updated</th><th>Actions</th></tr></thead>
            <tbody>
              {notes.length ? notes.map((note) => (
                <tr key={note.filename}>
                  <td><strong>{note.filename}</strong></td>
                  <td>{formatBytes(note.bytes)}</td>
                  <td>{new Date(note.modifiedAt).toLocaleString()}</td>
                  <td><div className="button-row"><button className="button button--quiet" disabled={busy} onClick={() => void view(note.filename)} type="button">View</button><button className="button button--quiet" disabled={busy} onClick={() => void copy(note.filename)} type="button">Copy</button><button className="button" disabled={busy} onClick={() => void open(note.filename)} type="button">Open</button></div></td>
                </tr>
              )) : <tr><td className="empty-state" colSpan={4}>No notes saved yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {selected ? <section className="panel section-panel"><div className="section-heading"><div><span className="eyebrow">Preview</span><h2>{selected.filename}</h2></div><button className="button" onClick={() => void copy(selected.filename)} type="button">Copy all</button></div><pre className="note-preview">{selected.content}</pre></section> : null}
    </div>
  );
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy is unavailable in this browser.");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
