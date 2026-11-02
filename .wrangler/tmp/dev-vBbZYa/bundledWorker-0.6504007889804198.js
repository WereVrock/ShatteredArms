var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/pages-oRmLNh/bundledWorker-0.6504007889804198.mjs
var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const room = sanitiseRoom(url.searchParams.get("room"));
      const id = env.MATCHMAKER.idFromName(room);
      const stub = env.MATCHMAKER.get(id);
      return stub.fetch(request);
    }
    if (url.pathname === "/api/highscores") {
      const id = env.HIGHSCORES.idFromName("global");
      const stub = env.HIGHSCORES.get(id);
      return stub.fetch(request);
    }
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      const adminUrl = new URL(request.url);
      adminUrl.pathname = "/admin.html";
      return env.ASSETS.fetch(new Request(adminUrl, request));
    }
    if (url.pathname === "/api/admin/highscores") {
      return handleAdminHighscores(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};
function sanitiseRoom(raw) {
  if (!raw) return "default";
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return cleaned || "default";
}
__name(sanitiseRoom, "sanitiseRoom");
__name2(sanitiseRoom, "sanitiseRoom");
async function handleAdminHighscores(request, env) {
  if (request.method !== "POST") {
    return json({ error: "method" }, 405);
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad-json" }, 400);
  }
  const expected = env.ADMIN_PASSWORD;
  if (typeof expected !== "string" || expected.length === 0) {
    return json({ error: "admin-not-configured" }, 500);
  }
  if (!body || typeof body.password !== "string" || body.password !== expected) {
    return json({ error: "unauthorized" }, 401);
  }
  const { password: _pw, ...rest } = body;
  const adminUrl = new URL(request.url);
  adminUrl.pathname = "/admin/highscores";
  const adminReq = new Request(adminUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rest)
  });
  const id = env.HIGHSCORES.idFromName("global");
  const stub = env.HIGHSCORES.get(id);
  return stub.fetch(adminReq);
}
__name(handleAdminHighscores, "handleAdminHighscores");
__name2(handleAdminHighscores, "handleAdminHighscores");
var Matchmaker = class {
  static {
    __name(this, "Matchmaker");
  }
  static {
    __name2(this, "Matchmaker");
  }
  constructor(state, env) {
    this.state = state;
    this.sessions = [];
  }
  async fetch(request) {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    if (this.sessions.length >= 2) {
      try {
        server.send(JSON.stringify({ type: "error", reason: "room-full" }));
      } catch {
      }
      try {
        server.close(1e3, "room-full");
      } catch {
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    const role = this.sessions.length === 0 ? "host" : "guest";
    const session = { ws: server, role };
    this.sessions.push(session);
    this._safeSend(server, { type: "welcome", role, peers: this.sessions.length });
    if (this.sessions.length === 2) {
      for (const s of this.sessions) this._safeSend(s.ws, { type: "paired" });
    }
    server.addEventListener("message", (event) => {
      for (const s of this.sessions) {
        if (s === session) continue;
        if (s.ws.readyState !== 1) continue;
        try {
          s.ws.send(event.data);
        } catch {
        }
      }
    });
    const cleanup = /* @__PURE__ */ __name2(() => {
      this.sessions = this.sessions.filter((s) => s !== session);
      for (const s of this.sessions) this._safeSend(s.ws, { type: "peerLeft" });
    }, "cleanup");
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);
    return new Response(null, { status: 101, webSocket: client });
  }
  _safeSend(ws, msg) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    } catch {
    }
  }
};
var MAX_STORED = 50;
var MAX_RETURN = 20;
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}
__name(corsHeaders, "corsHeaders");
__name2(corsHeaders, "corsHeaders");
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders()
  });
}
__name(json, "json");
__name2(json, "json");
var HighscoreBoard = class {
  static {
    __name(this, "HighscoreBoard");
  }
  static {
    __name2(this, "HighscoreBoard");
  }
  constructor(state, env) {
    this.state = state;
  }
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const url = new URL(request.url);
    if (url.pathname === "/admin/highscores") {
      return this._handleAdmin(request);
    }
    if (request.method === "GET") {
      const bv = clampInt(url.searchParams.get("balanceVersion"), 1, 9999, 1);
      const limit = clampInt(url.searchParams.get("limit"), 1, MAX_RETURN, 10);
      const list = await this._load(bv);
      return json({
        balanceVersion: bv,
        scores: list.slice(0, limit)
      });
    }
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "bad-json" }, 400);
      }
      const entry = sanitiseEntry(body);
      if (!entry) return json({ error: "invalid" }, 400);
      if (entry.score <= 0) return json({ accepted: false, reason: "zero" });
      const list = await this._load(entry.balanceVersion);
      list.push(entry);
      list.sort((a, b) => b.score - a.score || a.submittedAt - b.submittedAt);
      const trimmed = list.slice(0, MAX_STORED);
      await this._save(entry.balanceVersion, trimmed);
      const rank = trimmed.findIndex(
        (s) => s.submittedAt === entry.submittedAt && s.playerName === entry.playerName
      ) + 1;
      return json({
        accepted: true,
        rank: rank > 0 ? rank : null,
        balanceVersion: entry.balanceVersion
      });
    }
    return json({ error: "method" }, 405);
  }
  async _load(bv) {
    const key = `scores:v${bv}`;
    const data = await this.state.storage.get(key);
    return Array.isArray(data) ? data : [];
  }
  async _save(bv, list) {
    const key = `scores:v${bv}`;
    await this.state.storage.put(key, list);
  }
  // Admin operations. Every action takes a balanceVersion so a single
  // admin screen can manage any era's board. The password was verified
  // by the worker before this method runs.
  //
  // Actions:
  //   list     — return every stored score (no MAX_RETURN truncation)
  //   clearAll — delete the whole list for that balance version
  //   remove   — delete one entry, keyed by (submittedAt, playerName)
  async _handleAdmin(request) {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: "bad-json" }, 400);
    }
    const action = body.action;
    const bv = clampInt(body.balanceVersion, 1, 9999, 1);
    if (action === "list") {
      const list = await this._load(bv);
      return json({ balanceVersion: bv, scores: list });
    }
    if (action === "clearAll") {
      await this.state.storage.delete(`scores:v${bv}`);
      return json({ ok: true });
    }
    if (action === "remove") {
      const submittedAt = body.submittedAt;
      const playerName = body.playerName;
      if (typeof submittedAt !== "number" || typeof playerName !== "string") {
        return json({ error: "missing-key" }, 400);
      }
      const list = await this._load(bv);
      const filtered = list.filter(
        (s) => !(s.submittedAt === submittedAt && s.playerName === playerName)
      );
      if (filtered.length === list.length) {
        return json({ ok: false, reason: "not-found" });
      }
      await this._save(bv, filtered);
      return json({ ok: true });
    }
    if (action === "upsert") {
      const entry = sanitiseEntry(body.entry);
      if (!entry || entry.score <= 0) return json({ error: "invalid" }, 400);
      const list = await this._load(entry.balanceVersion);
      const kept = list.filter(
        (s) => !(s.playerName === entry.playerName && s.difficulty === entry.difficulty)
      );
      kept.push(entry);
      kept.sort((a, b) => b.score - a.score || a.submittedAt - b.submittedAt);
      await this._save(entry.balanceVersion, kept.slice(0, MAX_STORED));
      return json({ ok: true, balanceVersion: entry.balanceVersion });
    }
    return json({ error: "unknown-action" }, 400);
  }
};
function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
__name(clampInt, "clampInt");
__name2(clampInt, "clampInt");
function cleanText(raw, maxLen, fallback) {
  const src = typeof raw === "string" ? raw : String(raw || "");
  const trimmed = src.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}\s\-'.]/gu, "").trim();
  if (trimmed.length <= maxLen) return trimmed || fallback;
  let sliced = trimmed.slice(0, maxLen);
  const last = sliced.charCodeAt(sliced.length - 1);
  if (last >= 55296 && last <= 56319) sliced = sliced.slice(0, -1);
  return sliced || fallback;
}
__name(cleanText, "cleanText");
__name2(cleanText, "cleanText");
function sanitiseEntry(body) {
  if (!body || typeof body !== "object") return null;
  const score = Math.round(Number(body.score));
  if (!Number.isFinite(score) || score < 0) return null;
  const balanceVersion = clampInt(body.balanceVersion, 1, 9999, 1);
  const playerName = cleanText(body.playerName, 24, "Unknown");
  const commander = cleanText(body.commander, 40, "None");
  const difficulty = ["easy", "normal", "hard"].includes(body.difficulty) ? body.difficulty : "normal";
  const battles = Math.max(0, Math.min(999, parseInt(body.battles, 10) || 0));
  const gameVersion = String(body.gameVersion || "").slice(0, 40);
  const submittedAt = typeof body.submittedAt === "number" ? body.submittedAt : Date.now();
  return {
    playerName,
    score,
    battles,
    difficulty,
    commander,
    balanceVersion,
    gameVersion,
    submittedAt
  };
}
__name(sanitiseEntry, "sanitiseEntry");
__name2(sanitiseEntry, "sanitiseEntry");
var drainBody = /* @__PURE__ */ __name2(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
__name2(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name2(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
__name2(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
__name2(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");
__name2(__facade_invoke__, "__facade_invoke__");
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  static {
    __name(this, "___Facade_ScheduledController__");
  }
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name2(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name2(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name2(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
__name2(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name2((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name2((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
__name2(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;

// ../../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody2 = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default2 = drainBody2;

// ../../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError2(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError2(e.cause)
  };
}
__name(reduceError2, "reduceError");
var jsonError2 = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError2(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default2 = jsonError2;

// .wrangler/tmp/bundle-p1ScJD/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__2 = [
  middleware_ensure_req_body_drained_default2,
  middleware_miniflare3_json_error_default2
];
var middleware_insertion_facade_default2 = middleware_loader_entry_default;

// ../../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__2 = [];
function __facade_register__2(...args) {
  __facade_middleware__2.push(...args.flat());
}
__name(__facade_register__2, "__facade_register__");
function __facade_invokeChain__2(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__2(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__2, "__facade_invokeChain__");
function __facade_invoke__2(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__2(request, env, ctx, dispatch, [
    ...__facade_middleware__2,
    finalMiddleware
  ]);
}
__name(__facade_invoke__2, "__facade_invoke__");

// .wrangler/tmp/bundle-p1ScJD/middleware-loader.entry.ts
var __Facade_ScheduledController__2 = class ___Facade_ScheduledController__2 {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__2)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler2(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__2 === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__2.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__2) {
    __facade_register__2(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__2(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__2(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler2, "wrapExportedHandler");
function wrapWorkerEntrypoint2(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__2 === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__2.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__2) {
    __facade_register__2(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__2(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__2(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint2, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY2;
if (typeof middleware_insertion_facade_default2 === "object") {
  WRAPPED_ENTRY2 = wrapExportedHandler2(middleware_insertion_facade_default2);
} else if (typeof middleware_insertion_facade_default2 === "function") {
  WRAPPED_ENTRY2 = wrapWorkerEntrypoint2(middleware_insertion_facade_default2);
}
var middleware_loader_entry_default2 = WRAPPED_ENTRY2;
export {
  HighscoreBoard,
  Matchmaker,
  __INTERNAL_WRANGLER_MIDDLEWARE__2 as __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default2 as default
};
//# sourceMappingURL=bundledWorker-0.6504007889804198.js.map
