import type { ServerResponse } from "node:http";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DASHBOARD_DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const INDEX_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

/**
 * Serve the built React dashboard. Returns true when the pathname belongs to
 * the dashboard static surface, including handled errors.
 */
export function serveDashboardAsset(pathname: string, res: ServerResponse, distDir = DASHBOARD_DIST_DIR): boolean {
  if (pathname === "/dashboard" || pathname === "/dashboard/") {
    const indexPath = resolve(distDir, "index.html");
    if (!isFile(indexPath)) {
      res.writeHead(503, { ...INDEX_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end("Alfred dashboard is not built. Run `pnpm run web:build` and reload.");
      return true;
    }
    res.writeHead(200, INDEX_HEADERS);
    res.end(readFileSync(indexPath));
    return true;
  }

  if (!pathname.startsWith("/dashboard/assets/")) return false;

  let assetPathname: string;
  try {
    assetPathname = decodeURIComponent(pathname.slice("/dashboard/".length));
  } catch {
    sendAssetError(res, 400, "Invalid dashboard asset path.");
    return true;
  }

  const assetsDir = resolve(distDir, "assets");
  const assetPath = resolve(distDir, assetPathname);
  const relativePath = relative(assetsDir, assetPath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.includes(`..${sep}`)) {
    sendAssetError(res, 400, "Invalid dashboard asset path.");
    return true;
  }
  if (!isFile(assetPath)) {
    sendAssetError(res, 404, "Dashboard asset not found.");
    return true;
  }

  try {
    if (lstatSync(assetsDir).isSymbolicLink() || !isContainedPath(assetsDir, realpathSync(assetPath))) {
      sendAssetError(res, 400, "Invalid dashboard asset path.");
      return true;
    }
  } catch {
    sendAssetError(res, 404, "Dashboard asset not found.");
    return true;
  }

  res.writeHead(200, {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": CONTENT_TYPES[extname(assetPath).toLowerCase()] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(readFileSync(assetPath));
  return true;
}

function isContainedPath(parent: string, child: string): boolean {
  const realParent = realpathSync(parent);
  const relativePath = relative(realParent, child);
  return Boolean(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`);
}

function isFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sendAssetError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify({ ok: false, error }));
}
