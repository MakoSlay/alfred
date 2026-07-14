import test from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveDashboardAsset } from "../src/alfred-2/dashboard-assets.ts";

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function capture(pathname: string, distDir: string): CapturedResponse {
  const captured: CapturedResponse = { status: 0, headers: {}, body: "" };
  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(chunk?: string | Buffer) {
      captured.body = chunk === undefined ? "" : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      return this;
    },
  } as unknown as ServerResponse;
  assert.equal(serveDashboardAsset(pathname, response, distDir), true);
  return captured;
}

test("dashboard static server reports an explicit missing-build response", () => {
  const dir = mkdtempSync(join(tmpdir(), "alfred-dashboard-missing-"));
  try {
    const response = capture("/dashboard", dir);
    assert.equal(response.status, 503);
    assert.match(response.body, /pnpm run web:build/);
    assert.equal(response.headers["Cache-Control"], "no-store");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboard static server rejects malformed encoded asset paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "alfred-dashboard-malformed-"));
  try {
    const response = capture("/dashboard/assets/%", dir);
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), { ok: false, error: "Invalid dashboard asset path." });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboard static server rejects symlink escapes", () => {
  const root = mkdtempSync(join(tmpdir(), "alfred-dashboard-symlink-"));
  const dist = join(root, "dist");
  const assets = join(dist, "assets");
  const outside = join(root, "outside.js");
  try {
    mkdirSync(assets, { recursive: true });
    writeFileSync(outside, "private content", "utf8");
    symlinkSync(outside, join(assets, "escape.js"));

    const response = capture("/dashboard/assets/escape.js", dist);
    assert.equal(response.status, 400);
    assert.equal(response.body.includes("private content"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
