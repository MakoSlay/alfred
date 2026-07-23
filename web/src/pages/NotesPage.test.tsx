import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  notes: vi.fn(),
  readNote: vi.fn(),
  openNote: vi.fn(),
}));

vi.mock("../api/client", () => ({ alfredApi: api }));

import { NotesPage } from "./NotesPage";

describe("NotesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.notes.mockResolvedValue({ ok: true, directory: "/Users/test/Documents/Alfred Notes", notes: [{ filename: "proposal.md", path: "/Users/test/Documents/Alfred Notes/proposal.md", bytes: 12, modifiedAt: "2026-07-20T12:00:00.000Z" }] });
    api.readNote.mockResolvedValue({ ok: true, filename: "proposal.md", path: "/Users/test/Documents/Alfred Notes/proposal.md", bytes: 12, modifiedAt: "2026-07-20T12:00:00.000Z", content: "Copyable proposal" });
    api.openNote.mockResolvedValue({ ok: true, path: "/Users/test/Documents/Alfred Notes/proposal.md", filename: "proposal.md", kind: "note" });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("lists user-visible notes and previews their content", async () => {
    render(<NotesPage />);
    expect(await screen.findByText("proposal.md")).toBeVisible();
    expect(screen.getByText("/Users/test/Documents/Alfred Notes")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText("Copyable proposal")).toBeVisible();
  });

  it("copies note content and opens notes through the local API", async () => {
    render(<NotesPage />);
    await screen.findByText("proposal.md");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Copyable proposal"));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(api.openNote).toHaveBeenCalledWith("proposal.md"));
    fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    await waitFor(() => expect(api.openNote).toHaveBeenCalledWith(undefined));
  });
});
