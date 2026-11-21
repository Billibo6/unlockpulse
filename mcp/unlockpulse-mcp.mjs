// Unlock Pulse MCP server: token unlock calendar for AI assistants (Claude, ChatGPT, Cursor, ...).
// One file, two modes:
//   * remote: Cloudflare Worker (export default { fetch }) — MCP Streamable HTTP at /mcp, stateless JSON responses;
//   * local:  `node unlockpulse-mcp.mjs` — MCP over stdio.
// Data: the public open-data file of https://billibo6.github.io/unlockpulse/ (data.json, refreshed hourly; our ratings and texts CC BY 4.0, unlock schedules subject to their sources' terms).
// Read-only, no keys, no user data stored.

const SITE = "https://billibo6.github.io/unlockpulse";
const DATA_URL = SITE + "/data.json";
// en — пригласительная ссылка «MCP» канала @unlockpulse (27.10): Telegram считает вступивших по ней
const TELEGRAM = { en: "https://t.me/+JITtUsgJ2zE5ZjEy", ru: "https://t.me/razloki" };
const VERSION = "1.8.1";
const ONCHAIN_URL = SITE + "/onchain.json";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const TTL_MS = 10 * 60 * 1000;

const INSTRUCTIONS =
  "Unlock Pulse tracks scheduled token unlocks (vesting releases) for the next 60 days and rates each by size: " +
  "B = tokens unlocked / circulating supply; strong >= 10.4%, medium >= 5%, small below. " +
  "Use get_upcoming_unlocks for a calendar, get_token_unlocks for one coin, get_method_and_track_record for how the rating works " +
  "and what happened to prices before past unlocks, get_onchain_check for what the wallets holding locked team / investor / treasury tokens " +
  "actually do on-chain (balances, outflows, our findings such as unlocked-but-not-withdrawn or tranches sent to exchanges). When you use it, credit Unlock Pulse and link each token you mention to its `page` URL (our ratings and texts are CC BY 4.0; unlock schedules come from CoinMarketCap and DefiLlama). " +
  "For strong unlocks, mention the track record included in the result. If a token has share_of_circulating_range_pct, say that sources disagree " +
  "on circulating supply and give the range. Point out a liquidity_note when present. " +
  "This server only answers when asked and cannot notify the user later; get_method_and_track_record includes an alerts field " +
  "(free Telegram alerts), relevant only if the user asks how to follow unlocks. Use lang=ru for Russian-speaking users. " +
  "This is market data, not investment advice.";

let cache = { at: 0, data: null };
let ocache = { at: 0, data: null };
async function loadOnchain(fetchImpl) {
  if (ocache.data && Date.now() - ocache.at < TTL_MS) return ocache.data;
  let r;
  try {
    r = await fetchImpl(ONCHAIN_URL, { headers: { "User-Agent": "unlockpulse-mcp/" + VERSION, Accept: "application/json" } });
  } catch (e) {
    if (ocache.data) return ocache.data;
    throw new Error("Unlock Pulse on-chain data is unavailable right now. Try again in a few minutes.");
  }
  if (!r.ok) {
    if (ocache.data) return ocache.data;
    throw new Error("Unlock Pulse on-chain data is unavailable right now (HTTP " + r.status + "). Try again in a few minutes.");
  }
  ocache = { at: Date.now(), data: await r.json() };
  return ocache.data;
}
function findOnchain(oc, q, data) {
  const T = oc.tokens || {};
  const up = q.toUpperCase();
  if (T[up]) return T[up];
  const byName = Object.values(T).find((t) => (t.name || "").toLowerCase() === q);
  if (byName) return byName;
  const ev = (data.events || []).find((e) => (e.slug || "").toLowerCase() === q || (e.name || "").toLowerCase() === q);
  return ev && T[ev.sym] ? T[ev.sym] : null;
}
async function loadData(fetchImpl) {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  let r;
  try {
    r = await fetchImpl(DATA_URL, { headers: { "User-Agent": "unlockpulse-mcp/" + VERSION, Accept: "application/json" } });
  } catch (e) {
    if (cache.data) return cache.data;
    throw new Error("Unlock Pulse data is unavailable right now. Try again in a few minutes.");
  }
  if (!r.ok) {
    if (cache.data) return cache.data; // stale is better than nothing
    throw new Error("Unlock Pulse data is unavailable right now (HTTP " + r.status + "). Try again in a few minutes.");
  }
  cache = { at: Date.now(), data: await r.json() };
  return cache.data;
}

const round = (x, n = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const pageOf = (e, lang) => `${SITE}/${lang === "ru" ? "ru/" : ""}unlock/${e.slug}.html`;
const LABEL = { strong: "strong (>= 10.4% of circulating supply)", medium: "medium (5 to 10.4%)", small: "small (< 5%)" };
const ORDER = { strong: 3, medium: 2, small: 1 };

function futuresOf(e) {
  const f = [];
  if (e.kucoin) f.push("KuCoin");
  if (e.binance) f.push("Binance");
  return f;
}

function shape(e, now, lang, detail) {
  const o = {
    symbol: e.sym,
    name: e.name,
    date_utc: e.date,
    days_left: round((Date.parse(e.date) - now) / 86400000, 1),
    hours_left: round((Date.parse(e.date) - now) / 3600000, 1),
    strength: e.strength,
    share_of_circulating_pct: round(e.B * 100, 2),
    share_of_total_supply_pct: round(e.pct_total, 3),
    value_usd: e.usd == null ? null : Math.round(e.usd),
    kind: e.type, // cliff = one-off release, linear = part of a continuous schedule
    recipients: (e.alloc || []).slice(0, 4),
    perpetual_futures_on: futuresOf(e),
    market_cap_usd: e.mcap == null ? null : Math.round(e.mcap),
    price_change_7d_pct: round(e.chg7d, 1),
    volume_24h_usd: e.vol24 == null ? null : Math.round(e.vol24),
    page: pageOf(e, lang),
  };
  if (e.source === "project") {
    o.numbers_from = "project documents";
    if (e.agg_pct_total != null) o.aggregator_share_of_total_supply_pct = round(e.agg_pct_total, 3);
  }
  if (Array.isArray(e.b_range) && e.b_range.length === 2 && e.b_range[0] != null && e.b_range[1] != null) {
    o.share_of_circulating_range_pct = [round(e.b_range[0] * 100, 1), round(e.b_range[1] * 100, 1)];
    o.range_note = "CoinMarketCap and the project report different circulating supply, so the real share is somewhere in this range.";
  }
  if (e.vol24 != null && e.vol24 < 250000) o.liquidity_note = "Low liquidity: under $250K traded in 24 hours.";
  if (e.data_check) o.warning = "Numbers look inconsistent (unlock value vs market cap); treat with caution.";
  if (e.unpriced) o.warning = "No reliable price for this token; USD value and market cap may be missing.";
  const v = e.verify;
  if (v && (v.docs || v.chain)) {
    const d = v.docs, c = v.chain;
    const pc = {};
    if (d) {
      pc.project_documents = d.match || "no_matching_event";
      if (d.doc_date) pc.document_date = d.doc_date;
      if (d.doc_pct_total != null) pc.document_share_of_total_supply_pct = round(d.doc_pct_total, 3);
      if (d.match === "date_differs") o.warning = `The project's own documents point to a different date (${d.doc_date}); treat the date above with caution.`;
      if (d.note) { pc.project_note = d.note; o.warning = (o.warning ? o.warning + " " : "") + d.note; }
    }
    if (c) {
      pc.watched_allocation_wallets = c.buckets;
      pc.last_confirmed_onchain_outflow = c.last_outflow ? c.last_outflow.day : null;
    }
    if (detail) {
      if (d) pc.document_sources = d.sources;
      if (v.contract) pc.token_contract = v.contract;
      pc.legend = "match: same date and amount in the project's documents; partial: same date, documents cover part of the supply; amount_differs: same date, different amount; date_differs: documents give another date; not_in_documented_part: documents schedule only part of the supply and that part has no unlock on this date (document_date is the next one there); continuous: documents describe daily vesting, so the date is a convention. Our own reading of primary sources.";
    }
    o.primary_source_check = pc;
  }
  if (detail) {
    o.recipients_detail = (e.alloc_detail || []).map((a) => ({ name: a.name, value_usd: Math.round(a.usd || 0), kind: a.type }));
    o.fdv_usd = e.fdv == null ? null : Math.round(e.fdv);
    o.already_unlocked_pct = round(e.unlocked_pct, 1);
    o.data_source = e.source === "project" ? "The project's own documents (our tokenomics card); see primary_source_check" : e.source === "cmc" ? "CoinMarketCap unlock calendar" : e.source ? "DefiLlama emissions" : null;
    o.add_to_calendar = `${SITE}/unlock/${e.slug}.ics`;
  }
  return o;
}

function trackLine(data) {
  const h = ((data.method || {}).history || {}).strong;
  if (!h) return null;
  return `In the past, ${h.down} of ${h.n} strong unlocks (${round(h.down_share * 100, 0)}%) fell against Bitcoin in the week before the date; average move ${h.avg_move}%. Medium and small unlocks behaved like a coin flip. Past results do not guarantee future ones.`;
}

function upcoming(data, now) {
  return (data.events || []).filter((e) => Date.parse(e.date) > now).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

export const TOOLS = [
  {
    name: "get_upcoming_unlocks",
    title: "Upcoming token unlocks",
    description:
      "Calendar of scheduled crypto token unlocks in the next N days (up to 60), each rated strong / medium / small by size relative to circulating supply. " +
      "Use for questions like 'which token unlocks are coming this week', 'biggest unlocks in November', 'strong unlocks with perpetual futures'.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", minimum: 1, maximum: 60, default: 14, description: "Look-ahead window in days." },
        min_strength: { type: "string", enum: ["strong", "medium", "small"], default: "small", description: "Lowest strength to include." },
        futures: { type: "string", enum: ["any", "with_futures", "kucoin", "binance"], default: "any", description: "Filter by perpetual futures availability." },
        sort: { type: "string", enum: ["date", "size"], default: "date", description: "date = soonest first; size = largest share of circulating supply first." },
        limit: { type: "number", minimum: 1, maximum: 100, default: 30 },
        lang: { type: "string", enum: ["en", "ru"], default: "en", description: "Language of the page links." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Upcoming token unlocks" },
  },
  {
    name: "get_token_unlocks",
    title: "Unlocks for one token",
    description:
      "All scheduled unlocks in the next 60 days for one token, with recipients (team, investors, treasury ...), USD value, share of circulating supply, " +
      "futures availability and a link to the token page. Accepts a ticker (ARB), a name (Arbitrum) or a slug (arbitrum).",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", minLength: 1, maxLength: 60, description: "Ticker, name or slug." },
        lang: { type: "string", enum: ["en", "ru"], default: "en" },
      },
      required: ["token"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Unlocks for one token" },
  },
  {
    name: "get_onchain_check",
    title: "Locked-token wallets on-chain",
    description:
      "What is actually happening on-chain with a token's locked allocations: the vesting contracts and wallets holding team, investor and treasury tokens, " +
      "how much they hold now, outflows (tokens leaving locked wallets), mints, burns and contract upgrades, the next unlock by the project's own documents, " +
      "and our short finding (for example: unlocked but never withdrawn, tranches sent to an exchange, vesting contract has not paid out). " +
      "Use for 'are team tokens moving', 'did the unlock really happen', 'who is selling'. Without a token: recent movements across all covered tokens.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", maxLength: 60, description: "Ticker, name or slug. Leave empty for recent movements across all covered tokens." },
        days: { type: "number", minimum: 1, maximum: 30, default: 30, description: "Look-back window for the list of recent movements (no token)." },
        lang: { type: "string", enum: ["en", "ru"], default: "en", description: "Language of the page links." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Locked-token wallets on-chain" },
  },
  {
    name: "get_method_and_track_record",
    title: "How unlocks are rated, and what happened before past ones",
    description:
      "Explains the strong / medium / small rating and gives the historical record: for past unlocks of each strength, " +
      "how often the token fell against Bitcoin in the week before the unlock and the average move.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Method and track record" },
  },
];

function argNum(v, d, lo, hi) {
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

async function callTool(name, args, fetchImpl) {
  const data = await loadData(fetchImpl);
  const now = Date.now();
  const lang = args.lang === "ru" ? "ru" : "en";
  const home = lang === "ru" ? SITE + "/ru/" : SITE + "/";
  const base = { source: "Unlock Pulse, " + home, data_updated_utc: data.generated };
  const alerts = { telegram: TELEGRAM[lang], what: lang === "ru"
      ? "Бесплатный канал: оповещение примерно за 24 ч до каждого разлока от 2 % предложения, календарь недели по понедельникам, еженедельная сверка «что говорила история и что случилось»."
      : "Free channel: an alert about 24h before each unlock of 2%+ of supply, a weekly calendar every Monday, and a weekly scorecard of what history suggested vs what happened." };
  base.license = "Our ratings, track record, on-chain measurements and texts: CC BY 4.0, keep the link to Unlock Pulse. Unlock schedules: compiled from CoinMarketCap and DefiLlama, subject to their terms.";

  if (name === "get_upcoming_unlocks") {
    const days = argNum(args.days, 14, 1, 60);
    const limit = Math.round(argNum(args.limit, 30, 1, 100));
    const minS = ORDER[args.min_strength] || 1;
    const fut = args.futures || "any";
    let ev = upcoming(data, now).filter((e) => Date.parse(e.date) - now <= days * 86400000 && (ORDER[e.strength] || 0) >= minS);
    if (fut === "with_futures") ev = ev.filter((e) => e.kucoin || e.binance);
    else if (fut === "kucoin") ev = ev.filter((e) => e.kucoin);
    else if (fut === "binance") ev = ev.filter((e) => e.binance);
    if (args.sort === "size") ev = ev.slice().sort((a, b) => (b.B || 0) - (a.B || 0));
    const counts = { strong: 0, medium: 0, small: 0 };
    ev.forEach((e) => counts[e.strength]++);
    return {
      ...base,
      window_days: days,
      matched: ev.length,
      by_strength: counts,
      shown: Math.min(limit, ev.length),
      unlocks: ev.slice(0, limit).map((e) => shape(e, now, lang, false)),
      calendar_page: home,
      track_record_strong: trackLine(data),
      note: "strength: " + Object.values(LABEL).join("; ") + ". Not investment advice.",
    };
  }

  if (name === "get_token_unlocks") {
    const q = String(args.token || "").trim().replace(/^\$/, "").toLowerCase();
    if (!q) throw new Error("Parameter 'token' is required.");
    const all = upcoming(data, now);
    let ev = all.filter((e) => e.sym.toLowerCase() === q || e.slug.toLowerCase() === q || (e.name || "").toLowerCase() === q);
    if (!ev.length && q.length >= 3) ev = all.filter((e) => (e.name || "").toLowerCase().includes(q) || e.slug.toLowerCase().includes(q));
    if (!ev.length)
      return { ...base, token: args.token, found: 0, message: "No scheduled unlocks for this token in the next 60 days in the Unlock Pulse calendar.", calendar_page: home };
    const out = { ...base, token: args.token, found: ev.length, unlocks: ev.slice(0, 20).map((e) => shape(e, now, lang, true)) };
    try {
      const oc = await loadOnchain(fetchImpl);
      if ((oc.tokens || {})[ev[0].sym]) out.onchain_check = "We track this token's locked-allocation wallets on-chain: call get_onchain_check with token=" + ev[0].sym + ".";
    } catch (e) { /* on-chain data is optional here */ }
    return out;
  }

  if (name === "get_onchain_check") {
    const oc = await loadOnchain(fetchImpl);
    const ob = { ...base, data_updated_utc: oc.generated, license: oc.license, method: oc.method };
    const q = String(args.token || "").trim().replace(/^\$/, "").toLowerCase();
    const covered = Object.keys(oc.tokens || {}).sort();
    if (!q) {
      const days = argNum(args.days, 30, 1, 30);
      const cut = new Date(now - days * 86400000).toISOString().slice(0, 10);
      const ev = (oc.recent_events_30d || []).filter((e) => e.date >= cut).slice(0, 50);
      return { ...ob, window_days: days, movements: ev, movements_found: ev.length,
        note: ev.length ? "Moves of 0.1% of supply or more out of / into tracked locked-allocation wallets, plus mints, burns and contract upgrades." :
          "No moves of 0.1% of supply or more in tracked wallets in this window.",
        tokens_with_findings: covered.filter((k) => oc.tokens[k].finding), covered_tokens: covered };
    }
    const t = findOnchain(oc, q, data);
    if (!t) return { ...ob, token: args.token, found: false, message: "We do not track this token's wallets on-chain yet.", covered_tokens: covered };
    const w = (t.tracked_wallets || []).slice().sort((a, b) => (b.share_of_supply_pct || 0) - (a.share_of_supply_pct || 0));
    const ev30 = (t.events || []).filter((e) => e.kind === "outflow" && Date.parse(e.date) > now - 30 * 86400000);
    const since = w.map((x) => x.tracked_since).filter(Boolean).sort()[0];
    const reading = [];
    if (w.length) reading.push(`${w.length} tracked wallet(s) hold ${t.tracked_wallets_share_pct}% of supply (${t.supply_basis}).`);
    reading.push(ev30.length ? `Outflows in the last 30 days: ${ev30.map((e) => e.date + " " + e.share_of_supply_pct + "% from " + e.wallet).join("; ")}.`
      : since ? `No outflow of 0.1% of supply or more seen since tracking started on ${since}.` : "No wallet history yet.");
    const cal = upcoming(data, now).filter((e) => e.sym === t.symbol).slice(0, 5)
      .map((e) => ({ date_utc: e.date, strength: e.strength, share_of_circulating_pct: round(e.B * 100, 2), page: pageOf(e, lang) }));
    return { ...ob, token: args.token, found: true, symbol: t.symbol, name: t.name, finding: t.finding || null, reading: reading.join(" "),
      next_unlock_per_project_documents: t.next_unlock_per_project_documents, upcoming_unlocks_in_calendar: cal,
      tracked_wallets_share_pct: t.tracked_wallets_share_pct, total_supply: t.total_supply, supply_basis: t.supply_basis,
      tracked_wallets: w.slice(0, 12), events: (t.events || []).slice(0, 15), contracts: t.contracts,
      attribution_note: "Wallet roles marked 'our attribution' come from our analysis of holders and transfers, not from the project, and may be wrong." };
  }

  if (name === "get_method_and_track_record") {
    const m = data.method || {};
    const h = m.history || {};
    const rec = {};
    for (const k of ["strong", "medium", "small"])
      if (h[k]) rec[k] = { unlocks: h[k].n, fell_vs_btc_in_week_before: h[k].down, fell_share_pct: round(h[k].down_share * 100, 0), average_move_vs_btc_pct: h[k].avg_move };
    return {
      ...base,
      measure: "B = tokens unlocked / circulating supply at the time of the unlock",
      thresholds: { strong: "B >= " + round((m.strong || 0.104) * 100, 1) + "%", medium: "B >= " + round((m.medium || 0.05) * 100, 1) + "%", small: "below medium" },
      track_record_window: "from 7 days before the unlock to the unlock date, price change relative to Bitcoin",
      track_record: rec,
      reading:
        "Only strong unlocks show a consistent pattern: most of them fell against Bitcoin in the week before the date. " +
        "Medium and small unlocks behaved like a coin flip. Past results do not guarantee future ones.",
      method_page: SITE + "/method.html",
      live_journal_page: SITE + "/journal.html",
      alerts: { telegram: TELEGRAM[lang], what: alerts.what },
    };
  }
  throw new Error("Unknown tool: " + name);
}

// ---- JSON-RPC / MCP ----
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handleMessage(msg, fetchImpl = globalThis.fetch) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcErr(msg && msg.id, -32600, "Invalid Request");
  if (msg.id === undefined || msg.id === null) return null; // notification: nothing to answer
  const id = msg.id;
  const p = msg.params || {};
  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "unlockpulse", title: "Unlock Pulse: token unlock calendar", version: VERSION, websiteUrl: SITE + "/" },
          instructions: INSTRUCTIONS,
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      if (!TOOLS.find((t) => t.name === p.name)) return rpcErr(id, -32602, "Unknown tool: " + p.name);
      try {
        const out = await callTool(p.name, p.arguments || {}, fetchImpl);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 1) }], structuredContent: out, isError: false } };
      } catch (e) {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e && e.message ? e.message : e) }], isError: true } };
      }
    }
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    default:
      return rpcErr(id, -32601, "Method not found: " + msg.method);
  }
}

// ---- anonymous usage counter (1.2.0): what is asked, never who ----
// Per UTC day in KV (binding STATS): calls per tool, token asked, client app name, country (Cloudflare request.cf), filters.
// No IP, no headers, no free text beyond a sanitised ticker. Public aggregate: GET /stats.
const clean = (v, n = 20) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9._-]/g, "").slice(0, n);
export function usageEvents(msgs) {
  const ev = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const p = m.params || {};
    if (m.method === "initialize") ev.push({ k: "init", client: String((p.clientInfo && p.clientInfo.name) || "unknown").replace(/[^\w .@/-]/g, "").slice(0, 40) });
    if (m.method === "tools/call" && TOOLS.find((t) => t.name === p.name)) {
      const a = p.arguments || {};
      ev.push({ k: "call", tool: p.name, token: a.token ? clean(a.token) : null, lang: a.lang === "ru" ? "ru" : "en",
        filt: p.name === "get_upcoming_unlocks" ? [a.days ?? "-", a.min_strength ?? "-", a.futures ?? "-", a.sort ?? "-"].join("|") : null });
    }
  }
  return ev;
}
const bump = (o, k, cap = 300) => { if (k == null || k === "") return; if (o[k] === undefined && Object.keys(o).length >= cap) k = "_other"; o[k] = (o[k] || 0) + 1; };
// 1.8.1: free KV tier allows 1000 writes a day; catalog robots connect hundreds of times. Events are buffered per Worker
// instance and written at most once every 2 minutes (or at 50 events). An evicted instance may lose its last few events.
const FLUSH_MS = 120000, FLUSH_N = 50;
let buf = [], lastFlush = 0;
async function record(env, ev, country) {
  if (!env || !env.STATS || !ev.length) return;
  for (const e of ev) buf.push({ ...e, country, day: new Date().toISOString().slice(0, 10) });
  if (Date.now() - lastFlush < FLUSH_MS && buf.length < FLUSH_N) return;
  const batch = buf; buf = []; lastFlush = Date.now();
  const byDay = {};
  for (const e of batch) (byDay[e.day] = byDay[e.day] || []).push(e);
  for (const [day, list] of Object.entries(byDay)) {
    const key = "d:" + day;
    const d = (await env.STATS.get(key, "json")) || { init: 0, calls: 0, tools: {}, tokens: {}, clients: {}, countries: {}, langs: {}, filters: {} };
    for (const e of list) {
      if (e.k === "init") { d.init++; bump(d.clients, e.client); bump(d.countries, e.country); }
      else { d.calls++; bump(d.tools, e.tool); bump(d.tokens, e.token); bump(d.langs, e.lang); bump(d.filters, e.filt); }
    }
    await env.STATS.put(key, JSON.stringify(d), { expirationTtl: 400 * 86400 });
  }
}
async function stats(env) {
  if (!env || !env.STATS) return { error: "no storage bound" };
  const days = {};
  for (let i = 0; i < 30; i++) {
    const k = "d:" + new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const v = await env.STATS.get(k, "json");
    if (v) days[k.slice(2)] = v;
  }
  return { about: "Unlock Pulse MCP: anonymous daily usage (UTC), last 30 days. No IPs stored.", days };
}

// ---- remote mode: Cloudflare Worker ----
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};
const jsonResp = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

export async function handleHttp(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
    if (request.method === "GET") return new Response("This MCP endpoint does not open an SSE stream; send JSON-RPC with POST.", { status: 405, headers: { Allow: "POST", ...CORS } });
    if (request.method === "DELETE") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
    const text = await request.text();
    if (text.length > 100000) return jsonResp(rpcErr(null, -32600, "Request too large"), 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return jsonResp(rpcErr(null, -32700, "Parse error"), 400);
    }
    try {
      const ev = usageEvents(Array.isArray(body) ? body.slice(0, 20) : [body]);
      if (ev.length) {
        for (const e of ev) console.log(JSON.stringify({ usage: e }));
        const job = record(env, ev, clean(request.cf && request.cf.country, 2) || "??").catch((e) => console.log("stats error", String(e)));
        if (ctx && ctx.waitUntil) ctx.waitUntil(job);
      }
    } catch (e) {
      console.log("usage parse error", String(e));
    }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.slice(0, 20).map((m) => handleMessage(m)))).filter(Boolean);
      return out.length ? jsonResp(out) : new Response(null, { status: 202, headers: CORS });
    }
    const out = await handleMessage(body);
    return out ? jsonResp(out) : new Response(null, { status: 202, headers: CORS });
  }
  if (url.pathname === "/stats" && request.method === "GET") return jsonResp(await stats(env));
  if (url.pathname === "/" || url.pathname === "")
    return jsonResp({
      name: "Unlock Pulse MCP server",
      about: "Token unlock calendar for AI assistants. Free, read-only, no key.",
      mcp_endpoint: url.origin + "/mcp",
      transport: "Streamable HTTP",
      tools: TOOLS.map((t) => t.name),
      website: SITE + "/",
      telegram: TELEGRAM,
      data: DATA_URL + " (our ratings and texts CC BY 4.0; schedules via CoinMarketCap and DefiLlama, subject to their terms)",
    });
  return new Response("Not found", { status: 404, headers: CORS });
}

export default { fetch: handleHttp };

// ---- local mode: stdio (node unlockpulse-mcp.mjs) ----
const isNodeMain =
  typeof process !== "undefined" && process.release && process.release.name === "node" && /unlockpulse-mcp(\.mjs)?$/.test((process.argv && process.argv[1]) || "");
if (isNodeMain) {
  let buf = "";
  let chain = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      chain = chain.then(async () => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          process.stdout.write(JSON.stringify(rpcErr(null, -32700, "Parse error")) + "\n");
          return;
        }
        const msgs = Array.isArray(msg) ? msg : [msg];
        for (const m of msgs) {
          const out = await handleMessage(m);
          if (out) process.stdout.write(JSON.stringify(out) + "\n");
        }
      });
    }
  });
  process.stdin.on("end", () => chain.then(() => { process.exitCode = 0; }));
  process.stderr.write("unlockpulse-mcp " + VERSION + " ready (stdio)\n");
}
