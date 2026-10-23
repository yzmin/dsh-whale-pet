/**
 * Host half of the whale pet.
 *
 * The pet's visible behaviour lives in the browser (`./client.js`). This half
 * only answers one question the browser cannot answer reliably: *what has
 * Harness actually been doing?* It folds the Host's own lifecycle events —
 * `session/event` (including `approval/asked` / `approval/decided`),
 * `api-session/status`, `api-session/error` — into a bounded, plain-JSON
 * record set, and publishes it over one loopback HTTP route.
 *
 * Design notes:
 * - The session log is the source of truth; this is a derived cache (see the
 *   Harness plugin practices). Nothing here is written back to a session.
 * - Reading is a plain `GET` of a plain JSON document, so the browser half needs
 *   no generated Typert codec and this package needs no build step.
 * - Every listener is registered inside `apply`, so unloading the row removes
 *   all of them.
 *
 * @module dsh-pet-whale
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Stable Loader identity. */
export const name = 'pet-whale';

/**
 * Durable peak/off accounting, kept beside the profile's other storage.
 *
 * The Host process is rebuilt on every DSH restart; without this file the
 * session's historical peak/off split would reset to zero even though the
 * session log still contains all tokens. Best-effort: a read or write failure
 * only disables persistence for this process, it never breaks the panel.
 */
const PERIOD_STORE = join(
  process.env.DSH_PROFILE_DIR
    ?? join(process.env.DSH_HOME ?? homedir(), 'profiles', process.env.DSH_PROFILE ?? 'desktop'),
  'storages',
  'pet-whale',
  'periods.json',
);
const PERIOD_STORE_VERSION = 1;
const MAX_STORED_SESSIONS = 400;

/**
 * Loopback route the browser half polls.
 *
 * The client fetches this as a same-origin relative URL, because in Electron the
 * renderer reaches the Host only through the same-origin bridge; building an
 * absolute `http://host:port` address would be rejected.
 */
const ROUTE_PATH = '/pet-whale/state';

/** Route prefix that serves this package's `assets/` directory. */
const ASSET_PATH = '/pet-whale/assets/';

/**
 * Media type per asset extension.
 *
 * Only formats a stock browser decodes without a license are listed; anything
 * else is refused rather than served with a guessed type, because a wrong
 * `Content-Type` makes `decodeAudioData` fail in the client with no useful error
 * to report.
 */
const ASSET_TYPES = new Map([
  ['wav', 'audio/wav'],
  ['mp3', 'audio/mpeg'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['flac', 'audio/flac'],
  ['webm', 'audio/webm'],
]);

/**
 * Bounded ledger size. A plain module constant rather than a `Config` field:
 * this package declares no `Config`, so it imports no schema library and stays
 * loadable from a bare profile link, where only Node builtins resolve.
 */
const MAX_RECORDS = 80;
/** Bounded pending-approval ledger; permissions are rare, so this is generous. */
const MAX_APPROVALS = 20;

/**
 * Listener options for every lifecycle subscription below.
 *
 * DSH dispatches agent- and session-scoped events through the agent's scope
 * carrier, and Cordis filters a listener out unless the emitted carrier's
 * `filter` accepts the listener's own context
 * (`cordis/src/events.ts:171-174`: `hook.global || !filter || filter(…, hook.ctx)`).
 * A root-mounted plugin is not inside that scope, so a bare `ctx.on` never fires
 * — verified in this session, where one subagent session started and finished
 * with every counter still at zero. `global: true` is the documented public
 * escape hatch ("receive the event regardless of context filter checks",
 * `EventOptions.global`) and is what lets one root plugin observe *all* sessions.
 */
const GLOBAL = { global: true };

/** Longest text fragment kept for one prompt or reply. */
const TEXT_LIMIT = 400;
/** Longest single line kept in the feed. */
const FEED_LIMIT = 60;

/**
 * Billing buckets, in the shape the provider reports them.
 *
 * DeepSeek bills *cache miss* at the full input rate and *cache hit* far
 * cheaper, so the two are kept apart all the way to the cost display.
 * `inputTokens` is the miss count; `cacheWriteTokens` is charged as a miss too.
 */
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];

/** A zeroed bucket set. */
function emptyTokens() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0 };
}

/**
 * Accumulate one provider usage sample into a bucket set.
 *
 * `reasoningTokens` is a *subset* of `outputTokens`, not an extra bucket, so the
 * billable output total is `outputTokens` alone and reasoning is a breakdown
 * field rather than a summand. Every field is optional on the wire.
 *
 * @param target - bucket set to mutate.
 * @param usage - the `TokenUsage` carried by an `assistant/message` event.
 */
function addUsage(target, usage) {
  if (usage === null || typeof usage !== 'object') return;
  for (const key of TOKEN_KEYS) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) target[key] += value;
  }
  target.requests += 1;
}

/** Sum every billable bucket: `reasoningTokens` is already inside output. */
function tokensTotal(tokens) {
  return tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
}

/** Deep-copy a bucket set so a response never shares state with the ledger. */
function cloneTokens(tokens) {
  const copy = {};
  for (const key of TOKEN_KEYS) copy[key] = tokens[key];
  copy.requests = tokens.requests;
  return copy;
}

/** A zeroed peak/off-peak pair, so every request can be priced by its own period. */
function emptyPeriods() {
  return { peak: emptyTokens(), off: emptyTokens() };
}

/** Deep-copy a peak/off pair. */
function clonePeriods(periods) {
  return {
    peak: cloneTokens(periods?.peak ?? emptyTokens()),
    off: cloneTokens(periods?.off ?? emptyTokens()),
  };
}

/**
 * Whether an event time falls in DeepSeek's peak billing window.
 *
 * Beijing time, Monday–Friday, 09:00–12:00 and 14:00–18:00. Weekends are
 * off-peak; statutory holidays are not modelled here, so a holiday request is
 * classified as peak and the estimate can be high (the UI says so).
 *
 * @param time - epoch milliseconds from the session event.
 */
function isPeakTime(time) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return false;
  const beijing = new Date(time + 8 * 60 * 60 * 1000);
  const day = beijing.getUTCDay();
  const hour = beijing.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}

/** The pricing bucket for one event time. */
function periodKey(time) {
  return isPeakTime(time) ? 'peak' : 'off';
}

/** Validate/copy a token bucket read from the persisted store. */
function storedTokens(value) {
  const tokens = emptyTokens();
  if (value === null || typeof value !== 'object') return tokens;
  for (const key of TOKEN_KEYS) {
    const count = value[key];
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) tokens[key] = count;
  }
  if (typeof value.requests === 'number' && Number.isFinite(value.requests) && value.requests > 0) {
    tokens.requests = value.requests;
  }
  return tokens;
}

/** Validate/copy a peak/off pair read from the persisted store. */
function storedPeriods(value) {
  return {
    peak: storedTokens(value?.peak),
    off: storedTokens(value?.off),
  };
}

/**
 * Optional Host service lookup.
 *
 * `ctx` is a Cordis proxy that THROWS on an undeclared service read
 * (`cannot get property "agents" without inject`). This plugin declares no
 * `inject`, so `ctx.agents` is not merely absent — it is an exception, and it
 * was thrown from inside the snapshot, turning the whole endpoint into a bare
 * 400 while looking like anything but the real cause.
 *
 * `ctx.get(name)` is the documented optional form: it returns undefined.
 *
 * @param ctx - the plugin context.
 * @param name - service key.
 * @returns the service, or undefined when the composition does not provide it.
 */
function service(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** Report a non-fatal problem through the optional logger. */
function warn(ctx, message) {
  try {
    service(ctx, 'logger')?.warn?.(message);
  } catch {
    /* logging must never be the thing that fails */
  }
}

/** Longest session age worth reporting; anything older is treated as unknown. */
const MAX_PLAUSIBLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Build the Platform client identity one balance query needs.
 *
 * `deepseekAccount.getBalance(client)` derives its request headers from this, so
 * a wrong shape means a rejected call rather than a wrong number. The timezone
 * offset is whole seconds east of UTC, matching the platform's convention.
 *
 * @returns the client metadata for this Host.
 */
function accountClient() {
  return {
    version: '0.2.0',
    locale: 'zh_CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  };
}

/**
 * Flatten one balance outcome into a plain, JSON-safe snapshot.
 *
 * The service answers `{ status: 'ready', value, bonusWallets }` or
 * `{ status: 'failed' }` or `null` when signed out, so anything unexpected reads
 * as "no balance" rather than throwing inside the request handler.
 *
 * @param outcome - the `getBalance` result.
 * @returns wallet arrays, or undefined when there is nothing to show.
 */
function readWallets(outcome) {
  if (outcome === null || typeof outcome !== 'object' || outcome.status !== 'ready') return undefined;
  const simplify = (wallet) => {
    if (wallet === null || typeof wallet !== 'object') return undefined;
    if (typeof wallet.balance !== 'string' || typeof wallet.currency !== 'string') return undefined;
    return { currency: wallet.currency, balance: wallet.balance };
  };
  return {
    wallets: (Array.isArray(outcome.value) ? outcome.value : []).map(simplify).filter(Boolean),
    bonusWallets: (Array.isArray(outcome.bonusWallets) ? outcome.bonusWallets : []).map(simplify).filter(Boolean),
  };
}

/** Collapse whitespace and clip one text fragment to a display-safe length. */
function clip(value, limit = TEXT_LIMIT) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Join the text blocks of one message, skipping attachment placeholders.
 * @param message - a `Message`-shaped value from a durable event, or unknown.
 * @returns the plain text the message carries, clipped.
 */
function messageText(message) {
  if (message === null || typeof message !== 'object') return '';
  const content = message.content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return clip(parts.join(' '));
}

/** Count tool-call blocks in one message. */
function messageToolCalls(message) {
  if (message === null || typeof message !== 'object') return 0;
  const content = message.content;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'tool-call') total += 1;
  }
  return total;
}

/**
 * Normalize an epoch timestamp to milliseconds, or reject it.
 *
 * `SessionHeader.createdAt` has been observed in SECONDS while every consumer
 * here works in milliseconds; treating seconds as milliseconds yields an age
 * measured from 1970 — the panel showed "1497404m 14s", which is exactly the
 * distance to the epoch rather than a session length.
 *
 * The two ranges cannot be confused: epoch milliseconds passed 10^11 in 1973,
 * while epoch seconds stay below it until the year 5138. A value outside the
 * plausible window is rejected outright rather than rendered as an absurd
 * duration, so a future unit change degrades to "unknown" instead of nonsense.
 *
 * @param value - candidate timestamp.
 * @returns epoch milliseconds, or undefined when the value is unusable.
 */
function epochMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 1e11 ? value * 1000 : value;
  // Anything before 2001 cannot be a plausible session start for this harness.
  return ms < 1e12 ? undefined : ms;
}

/** Basename of a Windows or POSIX path, without a trailing separator. */
function baseName(path) {
  if (typeof path !== 'string' || path === '') return '';
  const parts = path.split(/[\\/]+/u).filter(Boolean);
  return parts.length === 0 ? '' : parts[parts.length - 1];
}

/**
 * Host half: fold Harness activity into a bounded record set and serve it.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  /** Most recent interaction episodes, newest first. */
  const records = [];
  /** Per-session open episode, keyed by session id. */
  const open = new Map();
  /** Per-session running flag last observed. */
  const running = new Map();
  /** Per-session display label, learned from the header and durable title. */
  const labels = new Map();
  /** Recent one-line feed of notable activity, newest first. */
  const feed = [];
  /** Monotonic id source for records. */
  let nextId = 1;
  /**
   * Cached account balance.
   *
   * The panel polls this endpoint every 1.5 s, and `getBalance` is a real
   * Platform request, so the value is cached and refreshed on a slow timer
   * rather than fetched per request. `pending` collapses concurrent refreshes.
   */
  const balance = { value: undefined, at: 0, pending: false, error: undefined };
  /** How long a balance reading is reused. */
  const BALANCE_TTL_MS = 60_000;
  /** The tone asset, read once and served from memory. */
  const asset = { bytes: undefined, tried: false };

  /** Refresh the cached balance once, without ever throwing into a request. */
  const refreshBalance = (force) => {
    if (balance.pending) return;
    if (!force && balance.value !== undefined && Date.now() - balance.at < BALANCE_TTL_MS) return;
    const account = service(ctx, 'deepseekAccount');
    if (account === undefined || typeof account.getBalance !== 'function') return;
    balance.pending = true;
    Promise.resolve()
      .then(() => account.getBalance(accountClient()))
      .then((outcome) => {
        const wallets = readWallets(outcome);
        balance.at = Date.now();
        balance.error = undefined;
        // Keep the last good reading if this one simply had nothing to say.
        if (wallets !== undefined) balance.value = wallets;
      })
      .catch((error) => {
        balance.at = Date.now();
        balance.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        balance.pending = false;
      });
  };
  refreshBalance(false);
  /**
   * Running token totals per session — SETTLED episodes only.
   *
   * The split matters: an open episode owns its own in-flight buckets, and the
   * snapshot presents `settled + live`. Folding a live episode's usage into this
   * total as well would count it twice, which is exactly the bug the host test
   * caught. `startedAt` is the session's durable `header.createdAt` when known,
   * so it measures the session rather than this plugin's uptime.
   */
  const sessionTotals = new Map();
  /**
   * Pending approval requests, keyed by `sessionId + request id`.
   *
   * `approval/asked` and `approval/decided` are durable session events, so the
   * same `{ global: true }` subscription that folds turns also sees permissions
   * without touching the approval answerer chain. The map is bounded and cleared
   * for a disposed session; a decision removes its own row.
   */
  const approvals = new Map();

  /** Read or create the per-session accounting row. */
  const totalsOf = (sessionId) => {
    let entry = sessionTotals.get(sessionId);
    if (entry === undefined) {
      entry = {
        startedAt: undefined,
        lastEventAt: undefined,
        periodsFrom: undefined,
        tokens: emptyTokens(),
        periods: emptyPeriods(),
      };
      sessionTotals.set(sessionId, entry);
    }
    return entry;
  };

  /**
   * Whether a value may be used as a session key.
   *
   * Every map below is keyed by a session id that arrives from an event, and the
   * snapshot walks those maps. A non-string key would sail through the maps and
   * only blow up later inside the snapshot, turning the whole endpoint into a
   * bare 400 — so the gate is here, at the entry point, not at the read.
   */
  const isSessionKey = (value) => typeof value === 'string' && value !== '';

  /** Read or create the accounting row, or undefined for an unusable key. */
  const totalsOfKey = (sessionId) => (isSessionKey(sessionId) ? totalsOf(sessionId) : undefined);

  /** Persist settled per-session peak/off buckets across DSH restarts. */
  let persistWarned = false;
  const persist = () => {
    try {
      const sessions = [...sessionTotals]
        .filter(([sessionId, entry]) => isSessionKey(sessionId) && entry !== undefined)
        .sort((left, right) => (left[1].lastEventAt ?? 0) - (right[1].lastEventAt ?? 0))
        .slice(-MAX_STORED_SESSIONS)
        .map(([sessionId, entry]) => ({
          id: sessionId,
          label: labels.get(sessionId),
          startedAt: entry.startedAt,
          lastEventAt: entry.lastEventAt,
          periodsFrom: entry.periodsFrom,
          tokens: cloneTokens(entry.tokens),
          periods: clonePeriods(entry.periods),
        }));
      mkdirSync(dirname(PERIOD_STORE), { recursive: true });
      writeFileSync(PERIOD_STORE, JSON.stringify({
        version: PERIOD_STORE_VERSION,
        savedAt: Date.now(),
        sessions,
        // Today is derived from the interaction records in the browser, so they
        // must survive the Host restart too; otherwise "Today" clears while the
        // session totals remain.
        records: records.slice(0, MAX_RECORDS),
      }), 'utf8');
    } catch (error) {
      if (!persistWarned) {
        persistWarned = true;
        warn(ctx, `pet-whale: could not persist periods — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  try {
    const stored = JSON.parse(readFileSync(PERIOD_STORE, 'utf8'));
    if (stored?.version === PERIOD_STORE_VERSION && Array.isArray(stored.sessions)) {
      for (const row of stored.sessions) {
        if (!isSessionKey(row?.id)) continue;
        sessionTotals.set(row.id, {
          startedAt: epochMs(row.startedAt),
          lastEventAt: epochMs(row.lastEventAt),
          periodsFrom: epochMs(row.periodsFrom),
          tokens: storedTokens(row.tokens),
          periods: storedPeriods(row.periods),
        });
        if (typeof row.label === 'string' && row.label !== '') labels.set(row.id, clip(row.label, 80));
      }
    }
    if (Array.isArray(stored?.records)) {
      for (const row of stored.records) {
        if (row === null || typeof row !== 'object' || !isSessionKey(row.sessionId)) continue;
        if (typeof row.startedAt !== 'number' || typeof row.endedAt !== 'number') continue;
        records.push(row);
        if (typeof row.id === 'number' && Number.isFinite(row.id)) {
          nextId = Math.max(nextId, Math.floor(row.id) + 1);
        }
      }
      if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
    }
  } catch (error) {
    // ENOENT is the normal first run; any other read error is just a loss of
    // persisted detail, not a reason to fail the whole plugin.
    if (error?.code !== 'ENOENT') {
      warn(ctx, `pet-whale: could not read periods — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Add one bucket set into another, field by field. */
  const mergeTokens = (target, source) => {
    for (const key of TOKEN_KEYS) target[key] += source[key];
    target.requests += source.requests;
  };
  /** Merge a peak/off pair into another. */
  const mergePeriods = (target, source) => {
    mergeTokens(target.peak, source.peak);
    mergeTokens(target.off, source.off);
  };

  const feed_ = (kind, text, sessionId) => {
    feed.unshift({ kind, text: clip(text, TEXT_LIMIT), sessionId, time: Date.now() });
    if (feed.length > FEED_LIMIT) feed.length = FEED_LIMIT;
  };

  /**
   * Best-effort human label for one session.
   *
   * A durable title arrives through `session/title` and is cached in `labels`.
   * Until then, fall back to the working directory's basename, read from the
   * live agent when one exists. Both are optional: an unknown session still
   * gets a short id.
   */
  const labelFor = (sessionId) => {
    const known = labels.get(sessionId);
    if (known !== undefined) return known;
    // The registry is optional and its shape is not guaranteed: read it through
    // the non-throwing lookup and guard the method, not just the object. A throw
    // here would break the whole snapshot.
    const agents = service(ctx, 'agents');
    const cwd = typeof agents?.get === 'function'
      ? agents.get(sessionId)?.session?.header?.cwd
      : undefined;
    if (typeof cwd === 'string' && cwd !== '') return clip(baseName(cwd), 80);
    return clip(sessionId, 48);
  };

  const labelOf = (sessionId) => labels.get(sessionId) ?? clip(sessionId, 48);

  /** Append one finished episode, trimming the bounded window. */
  const pushRecord = (record) => {
    records.unshift(record);
    if (records.length > MAX_RECORDS) {
      records.length = MAX_RECORDS;
      open.clear();
    }
  };

  /**
   * Read or create the open episode for one session.
   *
   * The label is deliberately NOT copied onto the episode: a durable title can
   * arrive mid-episode (`session/title`), and a copy taken at creation time
   * would freeze the placeholder. Both readers below resolve it through
   * {@link labelFor}, so a late title still lands on the finished record.
   */
  const episodeOf = (sessionId, now) => {
    let episode = open.get(sessionId);
    if (episode === undefined) {
      episode = {
        sessionId,
        startedAt: now,
        prompt: '',
        reply: '',
        tools: 0,
        turns: 0,
        steps: 0,
        error: undefined,
        tokens: emptyTokens(),
        periods: emptyPeriods(),
      };
      open.set(sessionId, episode);
    }
    return episode;
  };

  /**
   * Move one open episode into the record list.
   *
   * The episode's own `error` (if any) travels with the record, so this needs no
   * separate outcome argument. Its token buckets are deep-copied: the session
   * totals keep accumulating, and a response must not alias ledger state.
   */
  const settle = (sessionId, now) => {
    const episode = open.get(sessionId);
    open.delete(sessionId);
    if (episode === undefined) return;
    // Fold the episode's in-flight buckets into the session total exactly once,
    // here, at the moment it stops being live. The peak/off split is folded with
    // the same rule so the cost estimate can price each request by its own period.
    const totals = totalsOf(sessionId);
    mergeTokens(totals.tokens, episode.tokens);
    if (totals.periods === undefined) totals.periods = emptyPeriods();
    mergePeriods(totals.periods, episode.periods ?? emptyPeriods());
    pushRecord({
      id: nextId,
      sessionId,
      label: labelFor(sessionId),
      startedAt: episode.startedAt,
      endedAt: now,
      durationMs: Math.max(0, now - episode.startedAt),
      prompt: episode.prompt,
      reply: episode.reply,
      tools: episode.tools,
      turns: episode.turns,
      steps: episode.steps,
      tokens: cloneTokens(episode.tokens),
      periods: clonePeriods(episode.periods),
      ...episode.error === undefined ? {} : { error: episode.error },
    });
    nextId += 1;
    persist();
  };

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id;
    if (!isSessionKey(sessionId)) return;
    const now = event.time;
    const data = event.data;

    // Session-level bookkeeping: the durable creation time anchors "how long has
    // this session been running", and every event advances the activity stamp.
    const totals = totalsOfKey(sessionId);
    const created = epochMs(session?.header?.createdAt);
    if (totals !== undefined && totals.startedAt === undefined && created !== undefined) {
      totals.startedAt = created;
    }
    // The first event also bounds the age when no usable creation time exists.
    if (totals !== undefined && totals.startedAt === undefined && typeof now === 'number' && now > 0) {
      totals.startedAt = now;
    }
    if (totals !== undefined && typeof now === 'number' && (totals.lastEventAt === undefined || now > totals.lastEventAt)) {
      totals.lastEventAt = now;
    }

    switch (event.type) {
      case 'user/message': {
        // A user-authored prompt opens (or re-opens) an episode for the session.
        const source = data?.source;
        if (source !== undefined && typeof source === 'object' && source.kind !== 'user') break;
        const episode = episodeOf(sessionId, now);
        episode.prompt = messageText(data);
        feed_('user', episode.prompt === '' ? 'a prompt' : episode.prompt, sessionId);
        break;
      }
      case 'assistant/message': {
        const episode = episodeOf(sessionId, now);
        const message = data?.message;
        const text = messageText(message);
        if (text !== '') episode.reply = text;
        episode.tools += messageToolCalls(message);
        episode.steps += 1;
        // Provider-reported usage rides on the settlement. It counts toward the
        // episode only; settling folds it into the session total, which keeps the
        // two disjoint so the snapshot can present their sum without double-counting.
        // The same sample also lands in the event's own peak/off bucket, because a
        // session can span both periods and a single blended rate would be wrong.
        // Prefer the step/request start period: a request that starts at 11:59 and
        // finishes at 12:01 is billed by when it ran, not when the reply landed.
        if (data?.usage !== undefined) {
          addUsage(episode.tokens, data.usage);
          if (episode.periods === undefined) episode.periods = emptyPeriods();
          const period = episode.pendingPeriod ?? periodKey(now);
          addUsage(episode.periods[period], data.usage);
          episode.pendingPeriod = undefined;
          const totals = totalsOf(sessionId);
          if (totals.periodsFrom === undefined) totals.periodsFrom = now;
        }
        break;
      }
      case 'step/start': {
        const episode = episodeOf(sessionId, now);
        episode.pendingPeriod = periodKey(now);
        break;
      }
      case 'turn/start': {
        const episode = episodeOf(sessionId, now);
        episode.turns += 1;
        break;
      }
      case 'tool/call': {
        const episode = episodeOf(sessionId, now);
        episode.tools += 1;
        break;
      }
      case 'approval/asked': {
        // A permission request is waiting for a human answer. Keep the tool and
        // reason so the pet can say what needs attention, not only that one exists.
        const id = data?.id;
        if (typeof id !== 'string' && typeof id !== 'number') break;
        const key = `${sessionId}\u0000${String(id)}`;
        const toolName = clip(typeof data?.toolName === 'string' ? data.toolName : 'tool', 80);
        approvals.set(key, {
          id: String(id),
          sessionId,
          toolName,
          reason: clip(typeof data?.reason === 'string' ? data.reason : '', TEXT_LIMIT),
          askedAt: typeof now === 'number' && now > 0 ? now : Date.now(),
        });
        if (approvals.size > MAX_APPROVALS) {
          // Map iteration is insertion order: drop the oldest request only.
          const oldest = approvals.keys().next().value;
          if (oldest !== undefined) approvals.delete(oldest);
        }
        feed_('approval', `需要授权 · ${toolName}`, sessionId);
        break;
      }
      case 'approval/decided': {
        const id = data?.id;
        if (typeof id === 'string' || typeof id === 'number') {
          approvals.delete(`${sessionId}\u0000${String(id)}`);
        }
        break;
      }
      case 'session/title': {
        const title = typeof data?.title === 'string' ? data.title.trim() : '';
        if (title !== '') labels.set(sessionId, clip(title, 80));
        break;
      }
      default:
        break;
    }
  }, GLOBAL);

  ctx.on('api-session/status', (sessionId, isRunningNow) => {
    if (!isSessionKey(sessionId)) return;
    const isRunning = isRunningNow === true;
    const previous = running.get(sessionId);
    running.set(sessionId, isRunning);
    const now = Date.now();
    if (isRunning) {
      // Opening the episode here means a session that is already working when
      // this plugin loads still gets a record, even without a prompt event.
      if (previous !== true) episodeOf(sessionId, now);
      return;
    }
    if (previous === true) settle(sessionId, now);
  }, GLOBAL);

  // A failure is attached to the open episode and announced in the feed; the
  // idle transition settles the record, so the client sees one row per episode.
  ctx.on('api-session/error', (sessionId, message) => {
    if (!isSessionKey(sessionId)) return;
    const text = clip(typeof message === 'string' ? message : String(message), TEXT_LIMIT);
    const now = Date.now();
    if (running.get(sessionId) === true) episodeOf(sessionId, now).error = text;
    feed_('error', text, sessionId);
  }, GLOBAL);

  ctx.on('session/disposed', (session) => {
    const sessionId = session?.id;
    if (!isSessionKey(sessionId)) return;
    running.delete(sessionId);
    labels.delete(sessionId);
    open.delete(sessionId);
    for (const [key, approval] of approvals) {
      if (approval.sessionId === sessionId) approvals.delete(key);
    }
    // Deliberately KEEP `sessionTotals`: a disposed session's tokens were really
    // spent, and the accounting should outlive the live registry entry.
  }, GLOBAL);

  /**
   * Seed the running set from the live agent registry.
   *
   * `api-session/status` is a *transition* feed: a plugin loaded while a turn is
   * already in flight would otherwise believe nothing is running until the next
   * start or stop. Reading the registry once removes that blind spot; a failure
   * here is non-fatal, because the listener keeps the map correct afterwards.
   */
  const seedRunning = () => {
    const agents = service(ctx, 'agents');
    if (agents === undefined || typeof agents.list !== 'function') return;
    const now = Date.now();
    for (const agent of agents.list()) {
      const sessionId = agent?.id;
      if (!isSessionKey(sessionId)) continue;
      const isRunning = agent.status === 'running';
      running.set(sessionId, isRunning);
      if (isRunning) episodeOf(sessionId, now);
    }
  };
  try {
    seedRunning();
  } catch (error) {
    warn(ctx, error instanceof Error ? error : new Error(String(error)));
  }

  /** The JSON document the browser half consumes. */
  const snapshot = () => {
    const now = Date.now();
    const active = [];
    for (const sessionId of running.keys()) {
      if (running.get(sessionId) !== true) continue;
      const episode = open.get(sessionId);
      active.push({
        sessionId,
        label: labelFor(sessionId),
        startedAt: episode?.startedAt ?? now,
        prompt: episode?.prompt ?? '',
        tools: episode?.tools ?? 0,
      });
    }

    // Session accounting, including the live episode's in-flight numbers so the
    // panel shows tokens and cost climbing during a long turn rather than only
    // after it settles.
    //
    // Each row is built inside its own guard and an unusable row is SKIPPED: one
    // bad session must cost its own row, not the whole endpoint. That is a real
    // lesson here — a throw in this loop turned the entire route into a bare 400
    // with no indication of which session or field was at fault.
    const sessions = [];
    for (const [sessionId, entry] of sessionTotals) {
      try {
        if (!isSessionKey(sessionId) || entry === undefined || entry.tokens === undefined) continue;
        const live = open.get(sessionId);
        const tokens = cloneTokens(entry.tokens);
        if (live !== undefined && live.tokens !== undefined) {
          for (const key of TOKEN_KEYS) tokens[key] += live.tokens[key];
          tokens.requests += live.tokens.requests;
        }
        const periods = entry.periods === undefined ? emptyPeriods() : clonePeriods(entry.periods);
        if (live !== undefined && live.periods !== undefined) mergePeriods(periods, live.periods);
        const startedAt = entry.startedAt;
        const lastEventAt = entry.lastEventAt ?? live?.startedAt;
        // A clamp as well as a normalization: even a correctly-built timestamp
        // must not produce a seven-day "session", so an implausible age is
        // reported as unknown instead of as a number nobody can act on.
        const rawElapsed = startedAt === undefined ? undefined : Math.max(0, now - startedAt);
        const plausible = rawElapsed !== undefined && rawElapsed <= MAX_PLAUSIBLE_AGE_MS && startedAt <= now;
        sessions.push({
          sessionId,
          label: labelFor(sessionId),
          startedAt: plausible ? startedAt : undefined,
          lastEventAt,
          elapsedMs: plausible ? rawElapsed : undefined,
          idleMs: lastEventAt === undefined ? undefined : Math.max(0, now - lastEventAt),
          running: running.get(sessionId) === true,
          tokens,
          periods,
          periodsFrom: entry.periodsFrom,
          totalTokens: tokensTotal(tokens),
        });
      } catch (error) {
        warn(ctx, `pet-whale: skipped a session row — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    sessions.sort((left, right) => (right.lastEventAt ?? 0) - (left.lastEventAt ?? 0));

    // Pending permissions, newest first. Built in its own guarded row so one
    // malformed approval costs its own entry, not the whole snapshot.
    const approvalRows = [];
    for (const approval of approvals.values()) {
      try {
        approvalRows.push({ ...approval, label: labelFor(approval.sessionId) });
      } catch (error) {
        warn(ctx, `pet-whale: skipped an approval row — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    approvalRows.sort((left, right) => right.askedAt - left.askedAt);

    return {
      version: 5,
      now,
      busy: active.length > 0,
      active,
      records: records.slice(0, MAX_RECORDS),
      feed: feed.slice(0, 20),
      sessions,
      approvals: approvalRows,
      approvalCount: approvalRows.length,
      grandTotalTokens: sessions.reduce((sum, row) => sum + row.totalTokens, 0),
      // Cached: the reading itself refreshes on its own slow timer so a 1.5 s
      // poll never turns into a Platform request.
      balance: balance.value === undefined
        ? undefined
        : { ...balance.value, at: balance.at, error: balance.error },
    };
  };

  ctx.inject(['webServer'], (scope) => {
    scope.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"ok":false,"error":"method not allowed"}');
          return;
        }
        // A throw here would surface to the caller only as the web server's bare
        // 400, which says nothing about what failed. Reporting the failure as a
        // readable payload keeps a snapshot bug diagnosable from the browser.
        // Kick a refresh on the way out, so a stale reading is replaced soon
        // without ever blocking this response on the network.
        refreshBalance(false);
        let body;
        try {
          body = JSON.stringify({ ok: true, ...snapshot() });
        } catch (error) {
          const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          warn(ctx, `pet-whale: snapshot failed — ${message}`);
          body = JSON.stringify({
            ok: false,
            error: message,
            stack: error instanceof Error ? String(error.stack).split('\n').slice(0, 6).join('\n') : undefined,
          });
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      },
    });

    /**
     * Serve this package's `assets/` directory.
     *
     * The tone is a file rather than synthesized notes so it can be replaced
     * without touching any code: drop in a different `assets/tone.wav` (or `.mp3`
     * / `.ogg` / `.m4a`), refresh the page, and the pet plays it.
     *
     * A static file for this package carries no request data, so it is read ONCE
     * and served from memory: a per-request read would put `readFileSync` on the
     * event loop, and the bytes cannot change without a restart anyway.
     *
     * Only names are accepted — no separators, no parent hops — so the route can
     * never reach outside the packaged directory.
     */
    scope.webServer.register({
      kind: 'prefix',
      path: ASSET_PATH.replace(/\/$/u, ''),
      handler: (req, res) => {
        const name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.slice(ASSET_PATH.length));
        const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
        const type = ASSET_TYPES.get(extension);
        const safe = /^[A-Za-z0-9._-]+$/u.test(name) && !name.includes('..') && type !== undefined;
        if (!safe) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('not found');
          return;
        }
        if (asset.bytes === undefined && !asset.tried) {
          asset.tried = true;
          try {
            asset.bytes = readFileSync(new URL(`./assets/${name}`, import.meta.url));
          } catch (error) {
            warn(ctx, `pet-whale: could not read assets/${name} — ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (asset.bytes === undefined) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('missing asset');
          return;
        }
        res.writeHead(200, {
          'content-type': type,
          'content-length': String(asset.bytes.length),
          // The bytes only change with the package, so a long cache is safe and
          // keeps a reconnecting page from refetching the tone.
          'cache-control': 'public, max-age=86400',
        });
        res.end(req.method === 'HEAD' ? undefined : asset.bytes);
      },
    });
  });
}
