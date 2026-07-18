// GENERATED FILE — do not edit. Source: hosts/pi/extensions/nvim-aware-pi.ts. Regenerate with `npm run build` (or `node scripts/build.mjs`).

// hosts/pi/extensions/nvim-aware-pi.ts
import { Type } from "typebox";

// core/proc.mjs
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
var DEFAULT_TIMEOUT_MS = 2e3;
function runProcess(command, args, options = {}) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = timeout > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeout}ms`));
    }, timeout) : void 0;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveProcess({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code
      });
    });
  });
}
async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index], index);
      }
    })
  );
  return results;
}
function parseFirstJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
function uniqueStrings(values) {
  return [...new Set(values.map((value) => value?.trim()).filter((value) => Boolean(value)))];
}
function uniqueExistingRealpaths(values) {
  const roots = [];
  const seen = /* @__PURE__ */ new Set();
  for (const value of uniqueStrings(values)) {
    const real = safeRealpath(value);
    if (seen.has(real)) continue;
    seen.add(real);
    roots.push(value);
  }
  return roots;
}
function isInside(parent, child) {
  if (!parent || !child) return false;
  const rel = relative(parent, child);
  return rel === "" || !rel.startsWith("..") && !rel.startsWith("/");
}
function vimSingleQuoted(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
function errorToMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function readEnvMs(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}

// core/config.mjs
function getExplicitServer() {
  return asNonEmptyString(process.env.NVIM_AWARE_SERVER);
}
function getSnapshotTtlMs() {
  return readEnvMs("NVIM_AWARE_SNAPSHOT_TTL_MS", 750);
}
function getPromptRefreshTimeoutMs() {
  return readEnvMs("NVIM_AWARE_PROMPT_TIMEOUT_MS", 800);
}

// core/discover.mjs
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// core/snapshot-lua.mjs
var SUMMARY_LUA = String.raw`
(function()
  local api = vim.api
  local fn = vim.fn
  local cursor = api.nvim_win_get_cursor(0)
  return fn.json_encode({
    cwd = fn.getcwd(),
    currentFile = api.nvim_buf_get_name(0),
    cursor = { line = cursor[1], column = cursor[2] + 1 },
  })
end)()
`;
function makeSnapshotLua(limits) {
  return String.raw`
(function()
  local api = vim.api
  local fn = vim.fn
  local surrounding = ${limits.surroundingLines}
  local max_selection_bytes = ${limits.maxSelectionBytes}
  local max_buffers = ${limits.maxBuffers}
  local max_quickfix_items = ${limits.maxQuickfixItems}
  local visual_block = string.char(22)
  local select_block = string.char(19)
  local newline = string.char(10)

  local function bool(v) return v == true or v == 1 end

  local function mode_is_visual(m)
    return m == 'v' or m == 'V' or m == visual_block or m == 's' or m == 'S' or m == select_block
  end

  local function pos(line, col)
    return { line = line or 0, column = col or 0 }
  end

  local function normalize(a, b)
    local a_line, a_col = a[2] or 0, a[3] or 0
    local b_line, b_col = b[2] or 0, b[3] or 0
    if a_line > b_line or (a_line == b_line and a_col > b_col) then
      return b, a
    end
    return a, b
  end

  local function slice_line(line_text, start_col, end_col)
    if start_col < 1 then start_col = 1 end
    local len = #line_text
    if end_col < 1 or end_col > len then end_col = len end
    if start_col > len then return '' end
    if end_col < start_col then return '' end
    return string.sub(line_text, start_col, end_col)
  end

  local function truncate_text(text, max_bytes)
    if max_bytes <= 0 then return '', #text > 0 end
    if #text <= max_bytes then return text, false end
    return string.sub(text, 1, max_bytes) .. newline .. '…[selection truncated]', true
  end

  local function read_selection(current_mode)
    local active = mode_is_visual(current_mode)
    local selection_mode = active and current_mode or fn.visualmode()
    local raw_start = active and fn.getpos('v') or fn.getpos([=['<]=])
    local raw_end = active and fn.getpos('.') or fn.getpos([=['>]=])
    local start_pos, end_pos = normalize(raw_start, raw_end)
    local start_line, start_col = start_pos[2] or 0, start_pos[3] or 0
    local end_line, end_col = end_pos[2] or 0, end_pos[3] or 0

    if start_line <= 0 or end_line <= 0 then return nil end

    local ok, lines = pcall(api.nvim_buf_get_lines, 0, start_line - 1, end_line, false)
    if not ok or not lines or #lines == 0 then return nil end

    if selection_mode == 'V' then
      -- Keep complete selected lines.
    elseif selection_mode == visual_block or selection_mode == select_block then
      local left = math.min(start_col, end_col)
      local right = math.max(start_col, end_col)
      for i, line_text in ipairs(lines) do
        lines[i] = slice_line(line_text, left, right)
      end
    else
      if #lines == 1 then
        lines[1] = slice_line(lines[1], start_col, end_col)
      else
        lines[1] = slice_line(lines[1], start_col, #lines[1])
        lines[#lines] = slice_line(lines[#lines], 1, end_col)
      end
    end

    local text, truncated = truncate_text(table.concat(lines, newline), max_selection_bytes)
    return {
      active = active,
      mode = selection_mode,
      start = pos(start_line, start_col),
      ['end'] = pos(end_line, end_col),
      text = text,
      truncated = truncated,
    }
  end

  local buffer_cache = {}

  local function buffer_name(bufnr)
    local cached_info = buffer_cache[bufnr]
    if cached_info and cached_info.name then return cached_info.name end
    local ok_name, name = pcall(api.nvim_buf_get_name, bufnr)
    return ok_name and name or ''
  end

  local function buffer_info(bufnr)
    local cached_info = buffer_cache[bufnr]
    if cached_info then return cached_info end

    local loaded = api.nvim_buf_is_loaded(bufnr)
    local line_count = 0
    if loaded then
      local ok_count, count = pcall(api.nvim_buf_line_count, bufnr)
      line_count = ok_count and count or 0
    end

    local filetype = ''
    if loaded then
      local ok_ft, ft = pcall(function() return vim.bo[bufnr].filetype end)
      filetype = ok_ft and ft or ''
    end

    local ok_modified, modified = pcall(function() return vim.bo[bufnr].modified end)
    local ok_listed, listed = pcall(function() return vim.bo[bufnr].buflisted end)

    local info = {
      bufnr = bufnr,
      name = buffer_name(bufnr),
      filetype = filetype,
      modified = ok_modified and bool(modified) or false,
      lineCount = line_count,
      listed = ok_listed and bool(listed) or false,
      visible = false,
    }
    buffer_cache[bufnr] = info
    return info
  end

  local visible_buffers = {}
  local windows = {}
  for _, win in ipairs(api.nvim_list_wins()) do
    local ok_buf, bufnr = pcall(api.nvim_win_get_buf, win)
    if ok_buf then
      visible_buffers[bufnr] = true
      local ok_cursor, win_cursor = pcall(api.nvim_win_get_cursor, win)
      table.insert(windows, {
        winid = win,
        bufnr = bufnr,
        file = buffer_name(bufnr),
        cursor = pos(ok_cursor and win_cursor[1] or 0, ok_cursor and (win_cursor[2] + 1) or 0),
      })
    end
  end

  local function buffer_info_from_getbufinfo(item)
    local bufnr = item.bufnr or 0
    if bufnr <= 0 then return nil end

    local loaded = bool(item.loaded)
    local filetype = ''
    if loaded then
      local ok_ft, ft = pcall(function() return vim.bo[bufnr].filetype end)
      filetype = ok_ft and ft or ''
    end

    local line_count = item.linecount or 0
    if line_count == 0 and loaded then
      local ok_count, count = pcall(api.nvim_buf_line_count, bufnr)
      line_count = ok_count and count or 0
    end

    local info = {
      bufnr = bufnr,
      name = item.name or buffer_name(bufnr),
      filetype = filetype,
      modified = bool(item.changed),
      lineCount = line_count,
      listed = true,
      visible = bool(visible_buffers[bufnr]),
    }
    buffer_cache[bufnr] = info
    return info
  end

  local buffers = {}
  local ok_bufinfo, listed_infos = pcall(fn.getbufinfo, { buflisted = 1 })
  if ok_bufinfo and listed_infos then
    for _, item in ipairs(listed_infos) do
      local info = buffer_info_from_getbufinfo(item)
      if info then
        table.insert(buffers, info)
        if #buffers >= max_buffers then break end
      end
    end
  else
    for _, bufnr in ipairs(api.nvim_list_bufs()) do
      local ok, info = pcall(buffer_info, bufnr)
      if ok and info.listed then
        info.visible = bool(visible_buffers[bufnr])
        table.insert(buffers, info)
        if #buffers >= max_buffers then break end
      end
    end
  end

  local function quickfix_filename(item)
    if type(item.filename) == 'string' and item.filename ~= '' then return item.filename end
    local bufnr = item.bufnr or 0
    if bufnr > 0 then return buffer_name(bufnr) end
    return ''
  end

  local function read_quickfix()
    if max_quickfix_items <= 0 then return nil end

    -- idx MUST be 0, not 1. Asking for a specific index narrows the returned
    -- items to that single entry, which silently reduced every quickfix list
    -- to one item. idx=0 reports the current index and returns the whole list.
    local ok_qf, qf = pcall(fn.getqflist, { title = 1, idx = 0, size = 1, items = 1 })
    if not ok_qf or type(qf) ~= 'table' then return nil end

    local all_items = qf.items or {}
    local size = qf.size or #all_items
    if size <= 0 or #all_items == 0 then return nil end

    local idx = qf.idx or 0
    local start_index = 1
    local end_index = math.min(#all_items, max_quickfix_items)
    if #all_items > max_quickfix_items and idx > 0 then
      start_index = math.max(1, idx - math.floor(max_quickfix_items / 2))
      end_index = math.min(#all_items, start_index + max_quickfix_items - 1)
      start_index = math.max(1, end_index - max_quickfix_items + 1)
    end

    local items = {}
    for index = start_index, end_index do
      local item = all_items[index]
      table.insert(items, {
        index = index,
        bufnr = item.bufnr or 0,
        filename = quickfix_filename(item),
        line = item.lnum or 0,
        column = item.col or 0,
        endLine = item.end_lnum or 0,
        endColumn = item.end_col or 0,
        type = item.type or '',
        text = item.text or '',
        valid = bool(item.valid),
      })
    end

    return {
      title = qf.title or '',
      currentIndex = idx,
      size = size,
      items = items,
      truncated = #all_items > #items,
    }
  end

  local current_mode = api.nvim_get_mode().mode
  local current_buf = api.nvim_get_current_buf()
  local cursor = api.nvim_win_get_cursor(0)
  local line = cursor[1]
  local column = cursor[2] + 1
  local start_line = math.max(1, line - surrounding)
  local end_line = math.min(api.nvim_buf_line_count(current_buf), line + surrounding)
  local surrounding_lines = {}
  local current_line = nil
  if surrounding > 0 then
    local ok_lines, lines = pcall(api.nvim_buf_get_lines, current_buf, start_line - 1, end_line, false)
    if ok_lines then
      for index, text in ipairs(lines) do
        local line_no = start_line + index - 1
        if line_no == line then current_line = text end
        table.insert(surrounding_lines, { line = line_no, text = text, current = line_no == line })
      end
    end
  end

  if current_line == nil then
    local ok_current_line, fetched_line = pcall(api.nvim_get_current_line)
    current_line = ok_current_line and fetched_line or ''
  end

  local current = buffer_info(current_buf)
  current.visible = true

  return fn.json_encode({
    cwd = fn.getcwd(),
    mode = current_mode,
    currentFile = current.name,
    currentBuffer = current,
    cursor = { line = line, column = column, lineText = current_line },
    surroundingLines = surrounding_lines,
    selection = read_selection(current_mode),
    search = fn.getreg('/'),
    quickfix = read_quickfix(),
    buffers = buffers,
    windows = windows,
  })
end)()
`;
}

// core/snapshot.mjs
var LIMIT_DEFAULTS = Object.freeze({
  surroundingLines: 5,
  maxSelectionBytes: 4e3,
  maxBuffers: 30,
  maxQuickfixItems: 30
});
var DEFAULT_SURROUNDING_LINES = LIMIT_DEFAULTS.surroundingLines;
var DEFAULT_MAX_SELECTION_BYTES = LIMIT_DEFAULTS.maxSelectionBytes;
var DEFAULT_MAX_BUFFERS = LIMIT_DEFAULTS.maxBuffers;
var DEFAULT_MAX_QUICKFIX_ITEMS = LIMIT_DEFAULTS.maxQuickfixItems;
var SnapshotShapeError = class extends Error {
  constructor(message, { raw } = {}) {
    super(message);
    this.name = "SnapshotShapeError";
    if (raw !== void 0) this.raw = excerpt(raw);
  }
};
function excerpt(text, max = 200) {
  const value = String(text);
  return value.length <= max ? value : `${value.slice(0, max)}\u2026`;
}
function normalizeLimits(limits = {}) {
  return {
    surroundingLines: Math.max(0, Math.floor(limits.surroundingLines ?? LIMIT_DEFAULTS.surroundingLines)),
    maxSelectionBytes: Math.max(0, Math.floor(limits.maxSelectionBytes ?? LIMIT_DEFAULTS.maxSelectionBytes)),
    maxBuffers: Math.max(1, Math.floor(limits.maxBuffers ?? LIMIT_DEFAULTS.maxBuffers)),
    maxQuickfixItems: Math.max(0, Math.floor(limits.maxQuickfixItems ?? LIMIT_DEFAULTS.maxQuickfixItems))
  };
}
function limitsKey(limits) {
  return `${limits.surroundingLines}:${limits.maxSelectionBytes}:${limits.maxBuffers}:${limits.maxQuickfixItems}`;
}
var expressionCache = /* @__PURE__ */ new Map();
function snapshotRequest(limits) {
  const normalized = normalizeLimits(limits);
  const key = limitsKey(normalized);
  let expression = expressionCache.get(key);
  if (!expression) {
    expression = `luaeval(${vimSingleQuoted(makeSnapshotLua(normalized))})`;
    expressionCache.set(key, expression);
  }
  return { kind: "snapshot", expression };
}
function summaryRequest() {
  return { kind: "summary", expression: `luaeval(${vimSingleQuoted(SUMMARY_LUA)})` };
}
function parseJson(raw, what) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new SnapshotShapeError(`Neovim returned an empty ${what}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new SnapshotShapeError(`Neovim returned unparseable ${what} JSON: ${errorToMessage(error)}`, { raw });
  }
}
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}
function asPosition(value) {
  return { line: Number(value?.line ?? 0), column: Number(value?.column ?? 0) };
}
function toSnapshot(raw, { server }) {
  const parsed = parseJson(raw, "snapshot");
  if (!parsed.currentBuffer || typeof parsed.currentBuffer !== "object") {
    throw new SnapshotShapeError("snapshot is missing currentBuffer", { raw });
  }
  if (!parsed.cursor || typeof parsed.cursor !== "object") {
    throw new SnapshotShapeError("snapshot is missing cursor", { raw });
  }
  const quickfix = parsed.quickfix ? { ...parsed.quickfix, items: asArray(parsed.quickfix.items), size: Number(parsed.quickfix.size ?? 0) } : null;
  return {
    server,
    cwd: parsed.cwd ?? "",
    mode: parsed.mode ?? "",
    currentFile: parsed.currentFile ?? "",
    currentBuffer: parsed.currentBuffer,
    cursor: { ...asPosition(parsed.cursor), lineText: parsed.cursor.lineText ?? "" },
    // Lua drops nil keys entirely, so absence is normal, not a defect.
    selection: parsed.selection ?? null,
    search: parsed.search ?? "",
    quickfix,
    surroundingLines: asArray(parsed.surroundingLines),
    buffers: asArray(parsed.buffers),
    windows: asArray(parsed.windows)
  };
}
function toSummary(raw, { server }) {
  const parsed = parseJson(raw, "server summary");
  return {
    server,
    cwd: parsed.cwd ?? "",
    currentFile: parsed.currentFile ?? "",
    cursor: asPosition(parsed.cursor)
  };
}
var snapshotCache = /* @__PURE__ */ new Map();
var snapshotInFlight = /* @__PURE__ */ new Map();
function cacheKey(server, limits) {
  return `${server}\0${limitsKey(limits)}`;
}
async function evaluate(server, request, timeoutMs) {
  const result = await runProcess("nvim", ["--server", server, "--remote-expr", request.expression], { timeoutMs });
  if (result.code !== 0) {
    throw new Error(`nvim --remote-expr failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim() || result.stderr.trim();
}
async function getNvimSnapshot(server, options = {}) {
  const limits = normalizeLimits(options);
  const raw = await evaluate(server, snapshotRequest(limits), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return toSnapshot(raw, { server });
}
async function getNvimServerSummary(server, options = {}) {
  const raw = await evaluate(server, summaryRequest(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return toSummary(raw, { server });
}
async function getCachedNvimSnapshot(server, options = {}, cacheOptions = {}) {
  const limits = normalizeLimits(options);
  const key = cacheKey(server, limits);
  const ttlMs = cacheOptions.ttlMs ?? 0;
  const cached = snapshotCache.get(key);
  if (!cacheOptions.force && ttlMs > 0 && cached && Date.now() - cached.createdAt <= ttlMs) {
    return cached.snapshot;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestKey = `${key}\0${timeoutMs}`;
  const inFlight = snapshotInFlight.get(requestKey);
  if (inFlight) return inFlight;
  const promise = getNvimSnapshot(server, { ...limits, timeoutMs }).then((snapshot) => {
    snapshotCache.set(key, { snapshot, createdAt: Date.now() });
    return snapshot;
  }).finally(() => snapshotInFlight.delete(requestKey));
  snapshotInFlight.set(requestKey, promise);
  return promise;
}
async function getPromptNvimSnapshot(server, { ttlMs, refreshTimeoutMs, options = {} }) {
  const limits = normalizeLimits(options);
  const cached = snapshotCache.get(cacheKey(server, limits));
  if (cached && Date.now() - cached.createdAt <= ttlMs) {
    return { snapshot: cached.snapshot };
  }
  const timeoutMs = cached ? refreshTimeoutMs : DEFAULT_TIMEOUT_MS;
  try {
    return { snapshot: await getCachedNvimSnapshot(server, { ...limits, timeoutMs }, { force: true }) };
  } catch (error) {
    if (cached) return { snapshot: cached.snapshot, warning: errorToMessage(error) };
    throw error;
  }
}

// core/discover.mjs
var PROBE_CONCURRENCY = 4;
var DEFAULT_PROBE_TIMEOUT_MS = 1200;
async function listServersFromNvim() {
  try {
    const result = await runProcess(
      "nvim",
      [
        "--headless",
        "--clean",
        "-n",
        "+echo json_encode({'self': v:servername, 'servers': serverlist()})",
        "+qa"
      ],
      { timeoutMs: 1500 }
    );
    const parsed = parseFirstJsonObject(result.stdout + result.stderr);
    if (!parsed?.servers || !Array.isArray(parsed.servers)) return [];
    return parsed.servers.filter((server) => typeof server === "string" && server && server !== parsed.self);
  } catch {
    return [];
  }
}
async function scanNvimSocketFiles() {
  if (process.platform === "win32") return [];
  const roots = uniqueExistingRealpaths([process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, tmpdir(), "/tmp"]);
  const sockets = [];
  const seen = /* @__PURE__ */ new Set();
  const maxSockets = 3e3;
  const addSocket = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    sockets.push(path);
  };
  const walk = async (dir, depth, inNvimishDir) => {
    if (depth < 0 || sockets.length >= maxSockets) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (sockets.length >= maxSockets) return;
      const path = join(dir, entry.name);
      const pathLower = path.toLowerCase();
      const nameIsNvimish = entry.name.toLowerCase().includes("nvim");
      const pathIsNvimish = inNvimishDir || nameIsNvimish || pathLower.includes("nvim");
      if (entry.isSocket?.()) {
        if (pathIsNvimish) addSocket(path);
        continue;
      }
      if (!entry.isDirectory()) {
        if (!pathIsNvimish) continue;
        try {
          if ((await lstat(path)).isSocket()) addSocket(path);
        } catch {
        }
        continue;
      }
      if (depth === 0) continue;
      if (pathIsNvimish) {
        await walk(path, depth - 1, true);
      }
    }
  };
  for (const root of roots) {
    await walk(root, 5, false);
  }
  return sockets;
}
async function fastCandidates(explicit) {
  if (explicit) return [explicit];
  return uniqueStrings([
    process.env.NVIM,
    process.env.NVIM_LISTEN_ADDRESS,
    ...await listServersFromNvim()
  ]);
}
async function probeSummaries(candidates, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  return mapWithConcurrency(candidates, PROBE_CONCURRENCY, async (server) => {
    try {
      return { server, summary: await getNvimServerSummary(server, { timeoutMs }) };
    } catch (error) {
      return { server, error: errorToMessage(error) };
    }
  });
}
function chooseBestNvimServer(items, cwd) {
  const best = items.find((item) => item.cwd === cwd) ?? items.find((item) => isInside(cwd, item.currentFile)) ?? items.find((item) => isInside(item.cwd, cwd)) ?? items[0];
  if (!best) throw new Error("No Neovim server candidates responded");
  return best;
}
async function collectServerSummaries(options = {}) {
  const explicit = options.explicit;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const fast = await fastCandidates(explicit);
  let results = fast.length > 0 ? await probeSummaries(fast, { timeoutMs }) : [];
  let summaries = results.flatMap((r) => r.summary ? [r.summary] : []);
  if (!explicit && summaries.length === 0) {
    const scanned = uniqueStrings((await scanNvimSocketFiles()).filter((s) => !fast.includes(s)));
    if (scanned.length > 0) {
      results = [...results, ...await probeSummaries(scanned, { timeoutMs })];
      summaries = results.flatMap((r) => r.summary ? [r.summary] : []);
    }
  }
  const failures = results.flatMap((r) => r.error ? [`${r.server}: ${r.error}`] : []);
  return { summaries, failures, candidateCount: summaries.length };
}
async function resolveServer(options = {}) {
  const explicit = options.explicit;
  if (explicit) return { server: explicit, candidateCount: 1 };
  const cwd = options.cwd ?? process.cwd();
  const { summaries, failures, candidateCount } = await collectServerSummaries({
    timeoutMs: options.timeoutMs
  });
  if (summaries.length === 0) {
    if (failures.length > 0) {
      throw new Error(`Found Neovim server candidates, but none responded. ${failures.join("; ")}`);
    }
    throw new Error(
      "No Neovim server found. Start Neovim normally, or run `nvim --listen /tmp/nvim-main` and set NVIM_AWARE_SERVER=/tmp/nvim-main."
    );
  }
  const best = chooseBestNvimServer(summaries, cwd);
  return { server: best.server, summary: best, candidateCount };
}

// core/format.mjs
function formatSystemPromptContext(snapshot) {
  return [
    "# Live Neovim context",
    "The user may refer to this editor state as 'current file', 'cursor', 'selection', 'quickfix', 'buffers', or 'search'. This is a live snapshot from Neovim at the time of the prompt.",
    ...formatSnapshot(snapshot, { compact: true })
  ].join("\n");
}
function formatSnapshot(snapshot, options) {
  const lines = [];
  const currentFile = snapshot.currentFile || "[No Name]";
  const modified = snapshot.currentBuffer.modified ? " modified" : "";
  const filetype = snapshot.currentBuffer.filetype ? ` ft=${snapshot.currentBuffer.filetype}` : "";
  lines.push(`- Neovim server: ${snapshot.server}`);
  lines.push(`- Neovim cwd: ${snapshot.cwd}`);
  lines.push(`- Mode: ${snapshot.mode}`);
  lines.push(`- Current file: ${currentFile}${filetype}${modified}`);
  lines.push(`- Cursor: line ${snapshot.cursor.line}, column ${snapshot.cursor.column}`);
  lines.push(`- Cursor line: ${snapshot.cursor.lineText}`);
  if (snapshot.selection) {
    const kind = snapshot.selection.active ? "active visual selection" : "last visual selection";
    lines.push(
      `- Selection: ${kind}, mode=${printableMode(snapshot.selection.mode)}, ${snapshot.selection.start.line}:${snapshot.selection.start.column}-${snapshot.selection.end.line}:${snapshot.selection.end.column}${snapshot.selection.truncated ? " (truncated)" : ""}`
    );
    if (snapshot.selection.text) {
      lines.push("```text");
      lines.push(snapshot.selection.text);
      lines.push("```");
    }
  } else {
    lines.push("- Selection: none");
  }
  if (snapshot.search) lines.push(`- Search register: ${snapshot.search}`);
  if (snapshot.quickfix && snapshot.quickfix.size > 0) {
    const title = snapshot.quickfix.title ? `: ${snapshot.quickfix.title}` : "";
    const shown = snapshot.quickfix.truncated ? `, showing ${snapshot.quickfix.items.length}` : "";
    const current = snapshot.quickfix.currentIndex > 0 ? `, current=${snapshot.quickfix.currentIndex}` : "";
    lines.push(`- Quickfix list (${snapshot.quickfix.size}${shown}${current})${title}`);
    const max = options.compact ? 8 : snapshot.quickfix.items.length;
    for (const item of snapshot.quickfix.items.slice(0, max)) {
      const marker = item.index === snapshot.quickfix.currentIndex ? ">" : " ";
      const kind = item.type ? ` ${item.type}` : "";
      const valid = item.valid ? "" : " invalid";
      const location = formatQuickfixLocation(item);
      lines.push(`  ${marker} [${item.index}]${kind}${valid} ${location}${item.text ? ` ${item.text}` : ""}`);
    }
    if (options.compact && snapshot.quickfix.items.length > max) {
      lines.push(`  - \u2026 ${snapshot.quickfix.items.length - max} more quickfix item(s); use nvim_context for full list`);
    }
  }
  if (!options.compact && snapshot.surroundingLines.length > 0) {
    lines.push("- Lines around cursor:");
    for (const row of snapshot.surroundingLines) {
      const marker = row.current ? ">" : " ";
      lines.push(`  ${marker} ${String(row.line).padStart(5, " ")} | ${row.text}`);
    }
  }
  if (!options.compact && snapshot.windows.length > 0) {
    lines.push("- Visible windows:");
    for (const win of snapshot.windows) {
      lines.push(`  - win ${win.winid}: ${win.file || "[No Name]"} @ ${win.cursor.line}:${win.cursor.column}`);
    }
  }
  if (snapshot.buffers.length > 0) {
    const displayedBuffers = options.compact ? snapshot.buffers.filter((buffer) => buffer.visible || buffer.modified).slice(0, 6) : snapshot.buffers;
    if (displayedBuffers.length > 0) {
      lines.push(`- Listed buffers (${snapshot.buffers.length}${snapshot.buffers.length >= DEFAULT_MAX_BUFFERS ? "+" : ""}):`);
      for (const buffer of displayedBuffers) {
        const flags = [buffer.visible ? "visible" : void 0, buffer.modified ? "modified" : void 0, buffer.filetype].filter(Boolean).join(", ");
        lines.push(`  - [${buffer.bufnr}] ${buffer.name || "[No Name]"}${flags ? ` (${flags})` : ""}`);
      }
      if (options.compact && snapshot.buffers.length > displayedBuffers.length) {
        lines.push(`  - \u2026 ${snapshot.buffers.length - displayedBuffers.length} more buffer(s); use nvim_context for full list`);
      }
    }
  }
  return lines;
}
function formatQuickfixLocation(item) {
  const file = item.filename || "[No file]";
  if (item.line <= 0) return file;
  const column = item.column > 0 ? `:${item.column}` : "";
  return `${file}:${item.line}${column}`;
}
function printableMode(mode) {
  if (mode === "") return "block";
  if (mode === "") return "select-block";
  if (mode === "V") return "line";
  if (mode === "v") return "char";
  return mode;
}

// hosts/pi/extensions/nvim-aware-pi.ts
function nvim_aware_pi_default(pi) {
  pi.registerFlag("nvim", {
    description: "Inject live context from a running Neovim instance",
    type: "boolean",
    default: false
  });
  pi.registerFlag("nvim-server", {
    description: "Neovim server address to use with --nvim (from :echo v:servername)",
    type: "string"
  });
  let enabled = false;
  let choice = null;
  const explicitServer = () => asNonEmptyString2(pi.getFlag("nvim-server")) ?? getExplicitServer();
  const ensureConnected = async (ctx) => {
    const resolved = await resolveServer({ explicit: explicitServer(), cwd: process.cwd() });
    choice = { server: resolved.server, candidateCount: resolved.candidateCount };
    if (ctx) {
      await getCachedNvimSnapshot(resolved.server, {}, { ttlMs: getSnapshotTtlMs() });
      setNvimStatus(ctx, resolved.candidateCount);
    }
    return choice;
  };
  pi.on("session_start", async (_event, ctx) => {
    enabled = pi.getFlag("nvim") === true;
    const activeTools = pi.getActiveTools();
    if (enabled && !activeTools.includes("nvim_context")) {
      pi.setActiveTools([...activeTools, "nvim_context"]);
    } else if (!enabled && activeTools.includes("nvim_context")) {
      pi.setActiveTools(activeTools.filter((tool) => tool !== "nvim_context"));
      ctx.ui.setStatus("nvim", void 0);
    }
    if (!enabled) return;
    try {
      await ensureConnected(ctx);
      ctx.ui.notify(`Connected to Neovim: ${choice?.server}`, "info");
    } catch (error) {
      ctx.ui.setStatus("nvim", ctx.ui.theme.fg("warning", "nvim: not connected"));
      ctx.ui.notify(errorToMessage(error), "warning");
    }
  });
  pi.registerCommand("nvim", {
    description: "Show the live Neovim context Pi sees",
    handler: async (_args, ctx) => {
      try {
        const selected = choice ?? await ensureConnected(ctx);
        const snapshot = await getCachedNvimSnapshot(selected.server, {}, { force: true });
        setNvimStatus(ctx, selected.candidateCount);
        ctx.ui.setWidget("nvim-context", formatSnapshot(snapshot, { compact: false }), {
          placement: "belowEditor"
        });
      } catch (error) {
        ctx.ui.notify(errorToMessage(error), "error");
      }
    }
  });
  pi.registerTool({
    name: "nvim_context",
    label: "Nvim Context",
    description: "Get live context from the connected Neovim instance: current file, cursor, selection, search register, quickfix list, windows, and listed buffers.",
    promptSnippet: "Fetch live Neovim editor context: current file, cursor, selection, search, quickfix, windows, and buffers.",
    promptGuidelines: [
      "Use nvim_context when the user refers to the current Neovim file, cursor, visual selection, quickfix list, errors/warnings, open buffers, current search, or says things like 'this code' without naming a path.",
      "When Neovim context includes absolute paths, prefer those exact paths with read/edit/write tools instead of guessing from Pi's current directory."
    ],
    parameters: Type.Object({
      includeSurroundingLines: Type.Optional(
        Type.Boolean({ description: "Include a small snippet around the cursor. Defaults to true." })
      ),
      maxSelectionBytes: Type.Optional(
        Type.Number({ description: "Maximum bytes of selected text to return. Defaults to 4000." })
      )
    }),
    async execute(_toolCallId, params) {
      const selected = choice ?? await ensureConnected();
      const snapshot = await getCachedNvimSnapshot(
        selected.server,
        {
          surroundingLines: params.includeSurroundingLines === false ? 0 : DEFAULT_SURROUNDING_LINES,
          maxSelectionBytes: params.maxSelectionBytes ?? DEFAULT_MAX_SELECTION_BYTES
        },
        { force: true }
      );
      return {
        content: [{ type: "text", text: formatSnapshot(snapshot, { compact: false }).join("\n") }],
        details: snapshot
      };
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return;
    try {
      const selected = choice ?? await ensureConnected(ctx);
      const { snapshot, warning } = await getPromptNvimSnapshot(selected.server, {
        ttlMs: getSnapshotTtlMs(),
        refreshTimeoutMs: getPromptRefreshTimeoutMs()
      });
      setNvimStatus(ctx, selected.candidateCount, warning ? "cached" : "connected");
      const cacheNote = warning ? `
- Note: Snapshot refresh failed (${warning}); using cached Neovim context.` : "";
      return {
        systemPrompt: `${event.systemPrompt}

${formatSystemPromptContext(snapshot)}${cacheNote}`
      };
    } catch (error) {
      ctx.ui.setStatus("nvim", ctx.ui.theme.fg("warning", "nvim: disconnected"));
      return {
        systemPrompt: `${event.systemPrompt}

Neovim context requested, but Pi could not read it: ${errorToMessage(error)}`
      };
    }
  });
}
function setNvimStatus(ctx, candidateCount, state = "connected") {
  const suffix = candidateCount > 1 ? ` +${candidateCount - 1}` : "";
  const color = state === "connected" ? "accent" : "warning";
  ctx.ui.setStatus("nvim", ctx.ui.theme.fg(color, `nvim: ${state}${suffix}`));
}
function asNonEmptyString2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
export {
  nvim_aware_pi_default as default
};
