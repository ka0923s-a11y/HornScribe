/**
 * devEngineBridge — a Vite dev-server middleware that gives plain-browser
 * `vite dev` sessions the same engine access the Tauri shell has (#86).
 *
 * The packaged app spawns `python -m hornscribe.worker` through Rust
 * (src-tauri/src/engine.rs). In a browser there is no process bridge, so
 * the frontend falls back to MockSidecarPort — which means `kind:"file"`
 * drops and pathless recordings could never reach the real engine.
 *
 * This plugin exposes a tiny localhost HTTP surface on the same origin:
 *   GET  /__engine/health      -> {ok, python}      (port probe)
 *   POST /__engine/spawn       -> spawn the worker (409 when running)
 *   GET  /__engine/events      -> SSE {kind:line|stderr|exit}
 *   POST /__engine/write       -> {line} appended to worker stdin
 *   POST /__engine/stdin-close -> close worker stdin (graceful EOF)
 *   POST /__engine/kill        -> terminate the worker
 *   POST /__engine/stage       -> raw body saved under %TEMP%/hornscribe-dev
 *                                 returns {path} so kind:"file" refs can
 *                                 reach the real engine too
 *
 * Python resolution mirrors engine.rs: HORNSCRIBE_PYTHON -> repo-local
 * .venv* (bp envs first) -> PATH. PYTHONPATH points at <repo>/python
 * unless HORNSCRIBE_PYTHONPATH overrides it.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const STAGE_DIR = path.join(tmpdir(), "hornscribe-dev");
const MAX_STAGE_BYTES = 512 * 1024 * 1024; // 512 MiB — a generous audio cap

/** Site-packages probe: does this venv have a package installed? */
function venvHas(venvDir, pkg) {
  return existsSync(path.join(venvDir, "Lib", "site-packages", pkg));
}

/** Repo-local virtualenv interpreters, best-first (mirrors engine.rs).
 *  The worker hard-requires music21 and benefits from basic_pitch, so
 *  envs are scored by what they can actually run — a stale basic-pitch
 *  env without music21 would crash the worker on import. */
function localVenvPythons() {
  const roots = [];
  let dir = path.resolve(DESKTOP_DIR);
  for (;;) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".venv") && entry.isDirectory()) {
          roots.push(path.join(dir, entry.name));
        }
      }
    } catch {
      /* unreadable dir — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const score = (v) =>
    (venvHas(v, "music21") ? 0 : 2) + (venvHas(v, "basic_pitch") ? 0 : 1);
  roots.sort((a, b) => {
    const d = score(a) - score(b);
    if (d !== 0) return d;
    return path.basename(a).localeCompare(path.basename(b));
  });
  return roots.map((v) => path.join(v, "Scripts", "python.exe"));
}

/** <repo>/python — the hornscribe package root — or null. */
function repoPythonDir() {
  if (process.env.HORNSCRIBE_PYTHONPATH) return process.env.HORNSCRIBE_PYTHONPATH;
  let dir = path.resolve(DESKTOP_DIR);
  for (;;) {
    const candidate = path.join(dir, "python", "hornscribe");
    if (existsSync(candidate)) return path.join(dir, "python");
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function whichExists(exe) {
  // Cheap PATH probe; `where` is present on every supported Windows,
  // `command -v` covers POSIX dev boxes.
  const probe = process.platform === "win32" ? "where" : "command";
  const args = process.platform === "win32" ? [exe] : ["-v", exe];
  const shell = process.platform !== "win32"; // `command` is a shell builtin
  const r = spawnSync(probe, args, { stdio: "ignore", shell });
  return r.status === 0;
}

/** Resolve {exe, pythonpath} or null when no interpreter is usable. */
function resolvePython() {
  const pythonpath = repoPythonDir();
  const explicit = process.env.HORNSCRIBE_PYTHON;
  if (explicit) {
    return existsSync(explicit) ? { exe: explicit, pythonpath } : null;
  }
  for (const exe of localVenvPythons()) {
    if (existsSync(exe)) return { exe, pythonpath };
  }
  for (const exe of ["python", "py"]) {
    if (whichExists(exe)) return { exe, pythonpath };
  }
  return null;
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function devEngineBridge() {
  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  let stdoutBuf = "";
  const sseClients = new Set();

  const broadcast = (obj) => {
    const data = "data: " + JSON.stringify(obj) + "\n\n";
    for (const res of [...sseClients]) {
      try {
        res.write(data);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  const fireExit = (code) => {
    child = null;
    broadcast({ kind: "exit", code });
  };

  const spawnWorker = () => {
    const resolved = resolvePython();
    if (!resolved) {
      throw new Error(
        "no usable Python found (set HORNSCRIBE_PYTHON or create a .venv)",
      );
    }
    const env = { ...process.env, PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" };
    if (resolved.pythonpath) env.PYTHONPATH = resolved.pythonpath;
    const proc = spawn(resolved.exe, ["-m", "hornscribe.worker"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;
    stdoutBuf = "";
    proc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(idx + 1);
        broadcast({ kind: "line", line });
      }
    });
    proc.stderr.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line) broadcast({ kind: "stderr", line });
      }
    });
    proc.on("exit", (code) => fireExit(code));
    proc.on("error", () => fireExit(null));
    return resolved;
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/__engine/health" && req.method === "GET") {
        const resolved = resolvePython();
        return json(res, 200, {
          ok: true,
          python: resolved ? resolved.exe : null,
          running: child != null,
        });
      }
      if (url.pathname === "/__engine/events" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write("retry: 1000\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      if (url.pathname === "/__engine/spawn" && req.method === "POST") {
        if (child) return json(res, 409, { error: "ENGINE_ALREADY_RUNNING" });
        const resolved = spawnWorker();
        return json(res, 200, { ok: true, python: resolved.exe });
      }
      if (url.pathname === "/__engine/write" && req.method === "POST") {
        if (!child || !child.stdin.writable) {
          return json(res, 410, { error: "engine is not running" });
        }
        const body = await readBody(req, 4 * 1024 * 1024);
        const { line } = JSON.parse(body.toString("utf8"));
        child.stdin.write(String(line) + "\n");
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/__engine/stdin-close" && req.method === "POST") {
        if (child && child.stdin.writable) child.stdin.end();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/__engine/kill" && req.method === "POST") {
        if (child) child.kill();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/__engine/stage" && req.method === "POST") {
        const body = await readBody(req, MAX_STAGE_BYTES);
        const raw = url.searchParams.get("name") || "audio.bin";
        // Strip path separators — the name only becomes a suffix tag.
        const safe = raw.replace(/[^\w.-]+/g, "_").slice(-80);
        await mkdir(STAGE_DIR, { recursive: true });
        const dest = path.join(STAGE_DIR, "staged-" + Date.now() + "-" + safe);
        await writeFile(dest, body);
        return json(res, 200, { path: dest });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    name: "hornscribe-dev-engine-bridge",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith("/__engine/")) {
          void handle(req, res);
        } else {
          next();
        }
      });
      const resolved = resolvePython();
      if (resolved) {
        server.config.logger.info(
          "[engine-bridge] dev engine available: " + resolved.exe,
        );
      } else {
        server.config.logger.warn(
          "[engine-bridge] no Python found — browser dev will use the mock engine",
        );
      }
    },
  };
}
