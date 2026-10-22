/**
 * Browser half of the whale pet.
 *
 * Rendering surface: `shell.overlay` — the frame-wide floating layer. That slot
 * is declared with `kind: 'list'`, `scope: 'root'` and passes the root standard
 * kit, so this component receives `useSessions` / `useSessionStatus` selector
 * hooks and can observe every session's running state without any DOM work.
 *
 * Three responsibilities:
 *  1. Draw the DeepSeek whale (the official silhouette path) with a working
 *     animation that reacts to whether Harness is busy.
 *  2. Chime once when a unit of work finishes, and subtly when one starts.
 *  3. Keep a local interaction ledger and show it in a panel opened by click.
 *
 * The ledger prefers the Host half's `/pet-whale/state` records, which carry the
 * real prompt text, reply excerpt, tool count, turns and errors. When that
 * endpoint is unreachable the pet degrades to a client-derived ledger built from
 * session running-state transitions, so the panel is never empty.
 *
 * No Harness Client package is imported as a module: React, ReactDOM and
 * React.createElement come from the browser module table.
 */

window.__ModuleLoader__.load({
  id: 'dsh-whale-pet',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback } = React;

    /* ------------------------------------------------------------------ *
     * Constants
     * ------------------------------------------------------------------ */

    const ENDPOINT = '/pet-whale/state';
    /**
     * Poll cadence is adaptive: the Host snapshot is the only source of the
     * interaction ledger, but an idle pet with its panel closed does not need a
     * 1.5 s heartbeat. Work and an open panel keep the fast cadence; idle slows
     * down; a hidden document backs off hard and refreshes immediately when it
     * becomes visible again.
     */
    const POLL_MS_BUSY = 1500;
    const POLL_MS_IDLE = 5000;
    const POLL_MS_HIDDEN = 20000;
    /** Re-read Client projections while the panel is open, independent of polling. */
    const PROJECTION_TICK_MS = 1200;
    const REQUEST_TIMEOUT_MS = 4000;
    const LOCAL_RECORD_LIMIT = 120;
    const STORAGE_KEY = 'dsh.pet.whale.records.v1';
    const PREFIX = 'dsh-pet-whale';
    /** Context-pressure thresholds, matching the chat composer's own alarm band. */
    const CONTEXT_WARN_RATIO = 0.8;
    const CONTEXT_CRITICAL_RATIO = 0.9;

    /** The official DeepSeek whale silhouette, as shipped in the Harness brand mark. */
    const WHALE_PATH =
      "M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z";

    /* ------------------------------------------------------------------ *
     * Cost accounting
     * ------------------------------------------------------------------ */

    /**
     * Per-1M-token rates, from the published DeepSeek price tables:
     * CNY — https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
     * USD — https://api-docs.deepseek.com/quick_start/pricing/
     *
     * Both are carried because the domestic platform bills in CNY while the
     * international page quotes USD, and the two are not a plain conversion of
     * each other. The user picks; CNY is the default.
     *
     * Off-peak is exactly half of peak in both currencies.
     *
     * `cacheWriteTokens` deliberately has no rate of its own — DeepSeek reports
     * it but bills it as a cache miss, i.e. at the full input rate.
     */
    const RATE_TABLES = {
      CNY: {
        symbol: '¥',
        label: '人民币 CNY',
        models: {
          'deepseek-flash': {
            label: 'deepseek-flash',
            peak: { hit: 0.04, miss: 2, output: 8 },
            offPeak: { hit: 0.02, miss: 1, output: 4 },
          },
          'deepseek-v4-pro': {
            label: 'deepseek-v4-pro',
            peak: { hit: 0.3, miss: 9, output: 27 },
            offPeak: { hit: 0.15, miss: 4.5, output: 13.5 },
          },
        },
      },
      USD: {
        symbol: '$',
        label: '美元 USD',
        models: {
          'deepseek-flash': {
            label: 'deepseek-flash',
            peak: { hit: 0.006, miss: 0.3, output: 1.2 },
            offPeak: { hit: 0.003, miss: 0.15, output: 0.6 },
          },
          'deepseek-v4-pro': {
            label: 'deepseek-v4-pro',
            peak: { hit: 0.044, miss: 1.32, output: 3.96 },
            offPeak: { hit: 0.022, miss: 0.66, output: 1.98 },
          },
        },
      },
    };
    /** Default billing currency: the domestic platform bills in CNY. */
    const DEFAULT_CURRENCY = 'CNY';
    /** Chosen model, overridable in localStorage. */
    const RATE_MODEL_KEY = `${STORAGE_KEY}.rateModel`;
    /** Chosen currency, overridable in localStorage. */
    const RATE_CURRENCY_KEY = `${STORAGE_KEY}.rateCurrency`;
    /** Whole-table override, as JSON, for when the published prices move. */
    const RATE_OVERRIDE_KEY = `${STORAGE_KEY}.rates`;
    /**
     * Peak windows in UTC hours [start, end), Monday to Friday. The Chinese page
     * states them as Beijing time 09:00–12:00 and 14:00–18:00 on weekdays, which
     * is exactly UTC 01:00–04:00 and 06:00–10:00, since Beijing is UTC+8. Both
     * pages therefore describe the same windows.
     */
    const PEAK_WINDOWS = [[1, 4], [6, 10]];

    /**
     * Whether a moment falls in a peak-pricing window.
     *
     * @param date - the instant to test.
     * @returns true when peak rates apply.
     */
    function isPeak(date) {
      const day = date.getUTCDay();
      if (day === 0 || day === 6) return false;
      const hour = date.getUTCHours();
      return PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end);
    }

    /**
     * Resolve the active rate table, model and currency.
     *
     * Every read is guarded: a corrupt override or an unavailable store leaves
     * the built-in tables in force rather than breaking the panel.
     *
     * @returns `{ table, models, currency, symbol, model }`.
     */
    function readRates() {
      const tables = { ...RATE_TABLES };
      try {
        const raw = window.localStorage.getItem(RATE_OVERRIDE_KEY);
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          // An override may replace one currency's table or add a new one; it
          // must not be able to delete the built-ins.
          if (parsed !== null && typeof parsed === 'object') {
            for (const [key, value] of Object.entries(parsed)) {
              if (value !== null && typeof value === 'object' && value.models !== undefined) tables[key] = value;
            }
          }
        }
      } catch {
        /* keep the built-in tables */
      }
      let currency = tables[DEFAULT_CURRENCY] === undefined ? Object.keys(tables)[0] : DEFAULT_CURRENCY;
      try {
        const chosen = window.localStorage.getItem(RATE_CURRENCY_KEY);
        if (typeof chosen === 'string' && tables[chosen] !== undefined) currency = chosen;
      } catch {
        /* keep the default currency */
      }
      const table = tables[currency];
      const models = table.models;
      let model = Object.keys(models)[0];
      try {
        const chosen = window.localStorage.getItem(RATE_MODEL_KEY);
        if (typeof chosen === 'string' && models[chosen] !== undefined) model = chosen;
      } catch {
        /* keep the default model */
      }
      return { table, models, currency, symbol: table.symbol, model };
    }

    /** Every selectable currency, for the panel's selector. */
    function currencyOptions() {
      return Object.entries(RATE_TABLES).map(([key, value]) => ({ key, label: value.label }));
    }

    /** Sum every billable bucket of one bucket set, matching the Host's rule. */
    function tokensTotal(tokens) {
      if (tokens === null || typeof tokens !== 'object') return 0;
      return (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0) + (tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0);
    }

    /**
     * Read one Client session projection by key.
     *
     * The documented shape is `SessionBinding.session.projections: ProjectionsFace`,
     * whose only declared method is `faceOf(key): ObservableSnapshot<unknown>`,
     * so the value is read with `getSnapshot()`. A bare `get(key)` is also tried
     * because the underlying store has one; neither is assumed.
     *
     * Every hop is optional and the whole read is guarded: the service shape is
     * not part of this plugin's contract, and a missing piece must degrade to
     * "no data" rather than break the panel.
     *
     * @param sessions - the `sessions` Client service, if the composition has one.
     * @param sessionId - the session to read.
     * @param key - projection key (`tokenUsage`, `contextPressure`, …).
     * @returns the projection's snapshot, or undefined when unavailable.
     */
    function readProjection(sessions, sessionId, key) {
      if (sessions === undefined || sessions === null || typeof sessionId !== 'string' || sessionId === '') return undefined;
      try {
        if (typeof sessions.binding !== 'function') return undefined;
        const projections = sessions.binding(sessionId)?.session?.projections;
        if (projections === null || typeof projections !== 'object') return undefined;

        let projection;
        if (typeof projections.faceOf === 'function') {
          projection = projections.faceOf(key)?.getSnapshot?.();
        }
        if (projection === undefined && typeof projections.get === 'function') {
          projection = projections.get(key);
        }
        return projection !== null && typeof projection === 'object' ? projection : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * Read the browser-side `tokenUsage` projection for one session.
     *
     * This is the fallback that keeps the accounting block useful when the Host
     * half is stale or absent. Session projections are registered on the Client
     * too — `dsh-token-meter` documents `tokenUsage` as carrying the durable
     * log's `uncachedInputTokens`, `outputTokens`, `cacheReadTokens` and
     * `cacheWriteTokens` — so the same billed breakdown is reachable without any
     * Host round trip.
     *
     * @param sessions - the `sessions` Client service, if the composition has one.
     * @param sessionId - the session to read.
     * @returns a bucket set, or undefined when the projection is unavailable.
     */
    function readClientTokens(sessions, sessionId) {
      const projection = readProjection(sessions, sessionId, 'tokenUsage');
      if (projection === undefined) return undefined;

      // `uncachedInputTokens` is this projection's name for the cache-miss bucket.
      const tokens = {
        inputTokens: projection.uncachedInputTokens ?? 0,
        outputTokens: projection.outputTokens ?? 0,
        cacheReadTokens: projection.cacheReadTokens ?? 0,
        cacheWriteTokens: projection.cacheWriteTokens ?? 0,
        reasoningTokens: 0,
        requests: 0,
      };
      return tokensTotal(tokens) > 0 ? tokens : undefined;
    }

    /**
     * Ask the Client to load one session's projections.
     *
     * `sessions.refreshProjections(sessionId)` "loads all Session projections
     * once per connection", so a reader that only borrowed a binding may still
     * see an empty projection until this runs. Fire-and-forget: a failure just
     * means the accounting stays on whatever the Host reported.
     *
     * @param sessions - the `sessions` Client service.
     * @param sessionId - the session to load.
     */
    function refreshClientTokens(sessions, sessionId) {
      if (sessions === undefined || sessions === null || typeof sessionId !== 'string') return;
      try {
        if (typeof sessions.refreshProjections !== 'function') return;
        const pending = sessions.refreshProjections(sessionId);
        if (pending !== null && typeof pending?.catch === 'function') pending.catch(() => {});
      } catch {
        /* the projection simply stays unavailable */
      }
    }

    /* ------------------------------------------------------------------ *
     * Context insight (shared with dsh-context)
     * ------------------------------------------------------------------ */

    /** A finite, non-negative number, or zero. */
    function nonNegative(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    }

    /** Compact token counts for the context card: 1_000_000 → 1.0M, 42_300 → 42.3k. */
    function compact(value) {
      const number = nonNegative(value);
      if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
      if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
      return String(Math.round(number));
    }

    /** Map an occupancy ratio onto the card's alarm band. */
    function contextLevel(ratio) {
      if (ratio === undefined) return 'none';
      if (ratio >= CONTEXT_CRITICAL_RATIO) return 'critical';
      if (ratio >= CONTEXT_WARN_RATIO) return 'warn';
      return 'calm';
    }

    /**
     * Build the whale's context reading.
     *
     * Three Client projections are consulted, all optional:
     *  - `contextPressure` / `contextBreakdown` — the harness' own token-meter
     *    projections, the exact figures behind the composer's context ring;
     *  - `contextTimeline` — dsh-context's richer session timeline, which adds
     *    the per-category composition, model/window metadata, and compaction
     *    and prune counters.
     *
     * The official pressure figure wins for occupancy because it is what the
     * composer warns on; the timeline supplies the breakdown and history only
     * when the official projections are missing. Nothing here mutates a
     * projection or requires dsh-context to be installed.
     *
     * @param sessions - the `sessions` Client service.
     * @param sessionId - the session to profile.
     * @returns a plain reading for the panel, or undefined.
     */
    function readContext(sessions, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;

      const pressure = readProjection(sessions, sessionId, 'contextPressure');
      const breakdown = readProjection(sessions, sessionId, 'contextBreakdown');
      const timeline = readProjection(sessions, sessionId, 'contextTimeline');
      const usage = readClientTokens(sessions, sessionId);

      const current = timeline !== undefined && timeline.current !== null && typeof timeline.current === 'object' ? timeline.current : undefined;
      const projected = nonNegative(pressure?.projectedTokens);
      const pressureTokens = nonNegative(pressure?.pressureTokens);
      const used = projected || pressureTokens || nonNegative(current?.total);
      const window = nonNegative(pressure?.contextWindow) || nonNegative(timeline?.contextWindow);
      const ratio = window > 0 && used > 0 ? Math.min(1, used / window) : undefined;

      /** Composition parts, in display order, from the richest NON-EMPTY source. */
      const parts = [];
      const breakdownTotal = breakdown === undefined
        ? 0
        : nonNegative(breakdown.systemTokens) + nonNegative(breakdown.toolsTokens) + nonNegative(breakdown.messageTokens);
      if (breakdown !== undefined && breakdownTotal > 0) {
        parts.push(
          { key: 'system', label: '系统提示 System', tokens: nonNegative(breakdown.systemTokens) },
          { key: 'tools', label: '工具 schema Tools', tokens: nonNegative(breakdown.toolsTokens) },
          { key: 'messages', label: '消息 Messages', tokens: nonNegative(breakdown.messageTokens) },
        );
      } else if (current !== undefined) {
        parts.push(
          { key: 'system', label: '系统提示 System', tokens: nonNegative(current.system) },
          { key: 'tools', label: '工具 schema Tools', tokens: nonNegative(current.tools) },
          {
            key: 'messages',
            label: '消息 Messages',
            tokens: nonNegative(current.user) + nonNegative(current.assistant) + nonNegative(current.tool),
          },
          { key: 'injected', label: '注入 Inject/Skill', tokens: nonNegative(current.inject) + nonNegative(current.skill) },
        );
      }
      const accounted = parts.reduce((sum, part) => sum + part.tokens, 0);
      // Pressure can include material the three official buckets do not name.
      // Show that remainder instead of silently shrinking the bar.
      if (used > accounted && used - accounted > 1) {
        parts.push({ key: 'other', label: '其他 Other', tokens: used - accounted });
      }

      const hit = nonNegative(usage?.cacheReadTokens);
      const inputSide = hit + nonNegative(usage?.inputTokens) + nonNegative(usage?.cacheWriteTokens);
      const counts = timeline?.counts !== undefined && timeline.counts !== null && typeof timeline.counts === 'object' ? timeline.counts : undefined;
      const events = Array.isArray(timeline?.events) ? timeline.events : [];
      const compactions = nonNegative(counts?.compactions) ||
        events.filter((event) => event?.kind === 'compaction').length;
      const prunes = nonNegative(counts?.prunes) ||
        events.filter((event) => event?.kind === 'prune').length;

      const hasTimeline = current !== undefined;
      const hasPressure = pressure !== undefined || breakdown !== undefined;
      if (!hasTimeline && !hasPressure && used === 0 && accounted === 0) return undefined;

      return {
        sessionId,
        used,
        window,
        ratio,
        level: contextLevel(ratio),
        parts: parts.filter((part) => part.tokens > 0 || part.key === 'messages'),
        accounted,
        hit,
        inputSide,
        compactions,
        prunes,
        turns: nonNegative(counts?.turns),
        steps: nonNegative(counts?.steps),
        reserve: nonNegative(timeline?.maxOutputTokens),
        cost: timeline !== undefined && timeline.cost !== null && typeof timeline.cost === 'object' ? timeline.cost : undefined,
        model: typeof timeline?.model === 'string' ? timeline.model : undefined,
        hasTimeline,
        hasPressure,
        source: hasTimeline ? 'dsh-context' : hasPressure ? 'projection' : 'tokens',
      };
    }

    /**
     * Price one bucket set.
     *
     * Returns every component separately so the panel can show where the money
     * went rather than only a total, plus `missTokens`, the bucket that actually
     * carries the full input rate.
     *
     * @param tokens - a bucket set from the Host snapshot.
     * @param rate - `{ hit, miss, output }` for the selected model and window.
     * @returns the component costs and their total, in USD.
     */
    function priceTokens(tokens, rate) {
      // The snapshot may arrive without a session row at all (a fresh load, or a
      // Host half that has not reported usage yet), so a missing shape must read
      // as zero rather than throw during render.
      const buckets = tokens !== null && typeof tokens === 'object' ? tokens : {};
      const per = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0) / 1_000_000;
      const missTokens = per(buckets.inputTokens) + per(buckets.cacheWriteTokens);
      const cacheHitCost = per(buckets.cacheReadTokens) * rate.hit;
      const inputCost = missTokens * rate.miss;
      const outputCost = per(buckets.outputTokens) * rate.output;
      return {
        cacheHitCost,
        inputCost,
        outputCost,
        total: cacheHitCost + inputCost + outputCost,
      };
    }

    /** A zeroed bucket set for the client-side rollups. */
    function zeroTokens() {
      return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0 };
    }

    /** Add one bucket set into another. */
    function addBuckets(target, source) {
      if (source === null || typeof source !== 'object') return target;
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'requests']) {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) target[key] += value;
      }
      return target;
    }

    /** Sum a peak/off pair into one bucket set. */
    function periodsTokens(periods) {
      const total = zeroTokens();
      if (periods === null || typeof periods !== 'object') return total;
      addBuckets(total, periods.peak);
      addBuckets(total, periods.off);
      return total;
    }

    /** `total - known`, clamped per field; used for the unrecorded remainder. */
    function subtractBuckets(total, known) {
      const rest = zeroTokens();
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'requests']) {
        rest[key] = Math.max(0, (total?.[key] ?? 0) - (known?.[key] ?? 0));
      }
      return rest;
    }

    /**
     * Price a peak/off pair with the matching period rates.
     *
     * This is the fallback when dsh-context's `contextTimeline.cost` is absent:
     * the Host records each assistant sample into the peak/off bucket of the
     * event's timestamp, so even without the projection the session is not
     * forced through whichever period happens to be active at render time.
     *
     * @returns `{cacheHitCost,inputCost,outputCost,total,split:true}`, or
     *   undefined when no period rates are available.
     */
    function pricePeriods(periods, table, fallbackModel) {
      if (periods === null || typeof periods !== 'object') return undefined;
      const models = table !== null && typeof table === 'object' && table.models !== null && typeof table.models === 'object' ? table.models : {};
      const rates = models[fallbackModel] ?? Object.values(models)[0];
      if (rates === undefined) return undefined;
      let cacheHitCost = 0;
      let inputCost = 0;
      let outputCost = 0;
      let saw = false;
      for (const period of ['peak', 'off']) {
        const bucket = periods[period];
        if (bucket === null || typeof bucket !== 'object') continue;
        const rate = period === 'peak' ? rates.peak : rates.offPeak;
        if (rate === undefined) continue;
        const priced = priceTokens(bucket, rate);
        cacheHitCost += priced.cacheHitCost;
        inputCost += priced.inputCost;
        outputCost += priced.outputCost;
        saw = true;
      }
      if (!saw) return undefined;
      return { cacheHitCost, inputCost, outputCost, total: cacheHitCost + inputCost + outputCost, split: true };
    }

    /**
     * Convert dsh-context's raw cost buckets into the display's peak/off shape.
     * This lets the peak/off rows show the full session even when the Host has
     * only recorded the period split since its own process started.
     */
    function periodsFromCostUsage(usage) {
      if (usage === null || typeof usage !== 'object') return undefined;
      const periods = { peak: zeroTokens(), off: zeroTokens() };
      let saw = false;
      for (const [providerId, provider] of Object.entries(usage)) {
        if (provider === null || typeof provider !== 'object') continue;
        // Non-DeepSeek providers have no real peak/off split in dsh-context;
        // they are booked under `peak` at list price. Returning those as peak
        // tokens would be a fake breakdown, so leave them to the record/Host
        // paths (or to the current-period fallback).
        if (providerId !== 'deepseek' && !providerId.startsWith('deepseek-')) continue;
        for (const model of Object.values(provider)) {
          if (model === null || typeof model !== 'object') continue;
          for (const period of ['peak', 'off']) {
            const bucket = model[period];
            if (bucket === null || typeof bucket !== 'object') continue;
            const target = periods[period];
            target.inputTokens += typeof bucket.uncached === 'number' ? bucket.uncached : 0;
            target.cacheReadTokens += typeof bucket.cacheRead === 'number' ? bucket.cacheRead : 0;
            target.cacheWriteTokens += typeof bucket.cacheWrite === 'number' ? bucket.cacheWrite : 0;
            target.outputTokens += typeof bucket.output === 'number' ? bucket.output : 0;
            saw = true;
          }
        }
      }
      return saw ? periods : undefined;
    }

    /**
     * Whether an instant falls in DeepSeek's peak billing window.
     * Beijing time, Monday–Friday, 09:00–12:00 and 14:00–18:00.
     */
    function isPeakTime(time) {
      if (typeof time !== 'number' || !Number.isFinite(time)) return false;
      const beijing = new Date(time + 8 * 60 * 60 * 1000);
      const day = beijing.getUTCDay();
      const hour = beijing.getUTCHours();
      return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
    }

    /**
     * Recover a peak/off split from interaction records.
     *
     * Records written before Host v5 have no `periods`, but they do carry the
     * episode's start/end time and its token buckets. Classifying the whole
     * episode by its end time is approximate for an episode that crosses a
     * boundary, but it is far better than pricing a brand-new off-peak session
     * at peak rates merely because dsh-context books non-DeepSeek providers
     * under its `peak` bucket.
     */
    function periodsFromRecords(records) {
      if (!Array.isArray(records)) return undefined;
      const periods = { peak: zeroTokens(), off: zeroTokens() };
      let saw = false;
      for (const record of records) {
        if (record === null || typeof record !== 'object') continue;
        const bucket = record.tokens;
        if (bucket === null || typeof bucket !== 'object') continue;
        const recorded = record.periods === null || typeof record.periods !== 'object' ? undefined : periodsTokens(record.periods);
        if (recorded !== undefined && tokensTotal(recorded) > 0) {
          addBuckets(periods.peak, record.periods.peak);
          addBuckets(periods.off, record.periods.off);
          saw = true;
          continue;
        }
        const at = typeof record.endedAt === 'number' ? record.endedAt : record.startedAt;
        if (typeof at !== 'number' || !Number.isFinite(at)) continue;
        addBuckets(periods[isPeakTime(at) ? 'peak' : 'off'], bucket);
        saw = true;
      }
      return saw ? periods : undefined;
    }

    /** Group digits for readability: `1234567` → `1,234,567`. */
    function count(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
      return number.toLocaleString('en-US');
    }

    /**
     * Format a money amount, keeping small charges legible.
     *
     * Sub-cent totals would round to `¥0.00`, which tells the user nothing, so
     * anything under a unit is shown fractionally instead. `$0.00393` is a real
     * charge; `$0.00` is not information.
     *
     * @param value - the amount.
     * @param symbol - the currency symbol to prefix.
     */
    function money(value, symbol = '¥') {
      const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      if (amount === 0) return `${symbol}0.00`;
      if (amount < 0.01) return `${symbol}${amount.toFixed(5)}`;
      if (amount < 1) return `${symbol}${amount.toFixed(4)}`;
      return `${symbol}${amount.toFixed(2)}`;
    }

    /**
     * Resolve "is Harness working right now" from the two observers.
     *
     * This is the rule that has been wrong twice, in opposite directions, so it
     * is a pure function with a test rather than an inline expression:
     *
     * - Preferring the Host hid work the Client could plainly see, because a
     *   stale Host reported `ok: true` with an empty ledger.
     * - A plain union then let one stuck Host claim freeze the pet on "working"
     *   forever after the turn ended.
     *
     * The Client's session-status view is live and self-correcting, so it wins
     * whenever it is loaded. The Host is believed only while the Client has no
     * view at all, which is the one case where going blind would be worse.
     *
     * @param input - `{ clientKnows, clientBusy, hostBusy }`.
     * @returns `{ busy, disagrees }`, where `disagrees` means the Host still
     *   claims work the Client cannot see.
     */
    function resolveBusy({ clientKnows, clientBusy, hostBusy }) {
      const hostClaimsBusy = hostBusy === true;
      return {
        busy: clientKnows ? clientBusy === true : hostClaimsBusy,
        disagrees: clientKnows === true && hostClaimsBusy && clientBusy !== true,
      };
    }

    /**
     * Format one wallet balance, choosing the symbol by its OWN currency.
     *
     * The Platform reports the amount as a string in the wallet's currency, so
     * the symbol must come from the wallet rather than from the selected rate
     * table — the two can legitimately differ.
     *
     * @param wallet - `{ currency, balance }`.
     * @returns display text.
     */
    function walletText(wallet) {
      const symbol = wallet.currency === 'CNY' ? '¥' : wallet.currency === 'USD' ? '$' : `${wallet.currency} `;
      const amount = Number(wallet.balance);
      if (!Number.isFinite(amount)) return `${symbol}${wallet.balance}`;
      return `${symbol}${amount.toFixed(2)}`;
    }

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    /** Two-digit clock time for one epoch millisecond value. */
    function clockTime(value) {
      const date = new Date(value);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    }

    /** Elapsed time as `1m 04s`, `12s` or `820ms`. */
    function duration(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
      if (value < 1000) return `${Math.round(value)}ms`;
      const seconds = Math.round(value / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
    }

    /** Length of a string in whole code points, so CJK is not over-counted. */
    function glyphs(value) {
      return typeof value === 'string' ? [...value].length : 0;
    }

    /** Keep one session id usable as a short label when nothing better exists. */
    function shortId(value) {
      if (typeof value !== 'string') return '';
      return value.length > 18 ? `${value.slice(0, 16)}…` : value;
    }

    /**
     * Choose the ledger to display. The Host half's records are authoritative —
     * they carry prompt text, reply excerpts, tool counts and errors — so they
     * replace the client-derived ledger entirely while the endpoint answers.
     * The local ledger is the offline fallback, not a second source, because
     * the two observe the same episodes and would otherwise duplicate rows.
     */
    function selectRecords(hostOk, hostRecords, localRecords) {
      if (hostOk && hostRecords.length > 0) {
        return hostRecords.map((record) => ({ ...record, origin: 'host' }));
      }
      return localRecords
        .map((record) => ({ ...record, origin: 'local' }))
        .sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
    }

    /** Read the persisted local ledger, tolerating absent or corrupt storage. */
    function readStored() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item) => item !== null && typeof item === 'object');
      } catch {
        return [];
      }
    }

    /** Persist the local ledger; a quota or privacy failure must not break the pet. */
    function writeStored(records) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, LOCAL_RECORD_LIMIT)));
      } catch {
        /* storage unavailable: the ledger stays in memory for this page */
      }
    }

    /* ------------------------------------------------------------------ *
     * Chime: Web Audio, no assets
     * ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ *
     * Chime: a small synthesized bell, no assets
     * ------------------------------------------------------------------ */

    /** One octave up, the shimmer partial every voice carries. */
    const OCTAVE = 2;
    /** Per-voice peak. Sized against `CHIME_MASTER` so the summed peak is ~0.92. */
    const VOICE_GAIN = 0.34;
    /**
     * Output trim.
     *
     * Deliberately above 1: a short, shaped bell has plenty of headroom, and the
     * limiter after it catches the peak. The first revision sat at 0.10 per voice
     * with no output stage at all, and the second was still reported as hard to
     * hear, so this is the loud end of comfortable rather than a cautious middle.
     */
    const CHIME_MASTER = 2.6;
    /** Note attacks, far enough apart that each partial is heard on its own. */
    const NOTE_GAP = 0.105;

    /**
     * Schedule one bell voice into any AudioContext-shaped object.
     *
     * Pure and synchronous, so `tools/chime-test.mjs` can drive it with a stub
     * context and assert the schedule and the loudness budget without a browser.
     *
     * The shape matters for "clear": a 6 ms linear attack avoids the click a
     * hard start makes, and an exponential decay to a near-zero floor is what
     * makes a bell read as a bell. A gain of exactly 0 is illegal for
     * `exponentialRampToValueAtTime`, hence the floor rather than 0.
     *
     * @param context - AudioContext, OfflineAudioContext, or a stub.
     * @param options - `{ at, frequency, duration, gain, type, attack, octave, shimmer }`,
     *   where the last three come from the selected tone's voicing.
     */
    function renderVoice(context, { at, frequency, duration, gain, type, attack = 0.006, octave = OCTAVE, shimmer = 0.2 }) {
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0.0001, at);
      envelope.gain.linearRampToValueAtTime(gain, at + attack);
      envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      // A second, quieter partial above the fundamental. This is what makes the
      // tone bright and "present" instead of the dull thud a lone sine gives; the
      // interval and level are the tone's voicing.
      const body = context.createOscillator();
      body.type = type;
      body.frequency.setValueAtTime(frequency, at);
      const shimmerOsc = context.createOscillator();
      shimmerOsc.type = 'sine';
      shimmerOsc.frequency.setValueAtTime(frequency * octave, at);
      const shimmerGain = context.createGain();
      shimmerGain.gain.setValueAtTime(gain * shimmer, at);

      body.connect(envelope);
      shimmerOsc.connect(shimmerGain);
      shimmerGain.connect(envelope);

      const stop = at + duration + 0.03;
      body.start(at);
      body.stop(stop);
      shimmerOsc.start(at);
      shimmerOsc.stop(stop);
      return envelope;
    }

    /**
     * Schedule one note sequence.
     *
     * Returns one envelope node PER NOTE rather than a single node, because each
     * note is its own gain stage. The caller is responsible for connecting them to
     * an output — a node that is never connected produces nothing at all, with no
     * error to notice.
     *
     * @param context - the target context.
     * @param notes - `{ frequency, duration, gain?, type? }[]`, played in order.
     * @param startAt - absolute start time.
     * @param voicing - the selected tone's timbre: `{ type, octave, shimmer, attack, gain }`.
     * @returns one envelope node per note, in play order.
     */
    function renderChime(context, notes, startAt, voicing = {}) {
      let cursor = startAt;
      const sources = [];
      for (const note of notes) {
        sources.push(renderVoice(context, {
          at: cursor,
          frequency: note.frequency,
          duration: note.duration,
          // Per-tone gain scales the shared voice peak, so a quiet tone stays
          // quiet without every note in it being rewritten.
          gain: VOICE_GAIN * (note.gain ?? 1) * (voicing.gain ?? 1),
          type: note.type ?? voicing.type ?? 'triangle',
          attack: voicing.attack,
          octave: voicing.octave,
          shimmer: voicing.shimmer,
        }));
        cursor += NOTE_GAP;
      }
      return sources;
    }

    /**
     * How long a note sequence takes to finish ringing, in seconds.
     *
     * The RING-OUT, not the last note's start: a note's duration extends past the
     * end of the sequence, and a caller wanting to know when the chime is over
     * would otherwise read a number that is too small.
     *
     * @param notes - the note data that was scheduled.
     * @param startAt - the absolute start time it was scheduled at.
     * @returns seconds from `startAt` until the last note finishes.
     */
    function ringOut(notes, startAt) {
      let endsAt = startAt;
      notes.forEach((note, index) => {
        endsAt = Math.max(endsAt, startAt + index * NOTE_GAP + note.duration);
      });
      return endsAt - startAt;
    }

    /**
     * Build the output stage: soft lowpass, then a limiter, then the trim.
     *
     * @param context - the target context.
     * @param masterGain - the selected tone's output trim, relative to
     *   `CHIME_MASTER`; a tone that should sit further back passes less.
     */
    function chimeOutput(context, masterGain = CHIME_MASTER) {
      const master = context.createGain();
      master.gain.setValueAtTime(masterGain, context.currentTime);
      const bus = context.createGain();
      // Two paths, so the compressor reacts to both an open and a soft tone.
      const softener = context.createBiquadFilter();
      softener.type = 'lowpass';
      softener.frequency.setValueAtTime(4200, context.currentTime);
      bus.connect(master);
      bus.connect(softener);
      softener.connect(master);
      const limiter = context.createDynamicsCompressor();
      // A high threshold keeps the bell's shape; the knee and ratio only catch
      // the summed peak, so loudness rises without the tone going squashed.
      limiter.threshold.setValueAtTime(-8, context.currentTime);
      limiter.knee.setValueAtTime(10, context.currentTime);
      limiter.ratio.setValueAtTime(10, context.currentTime);
      limiter.attack.setValueAtTime(0.003, context.currentTime);
      limiter.release.setValueAtTime(0.18, context.currentTime);
      master.connect(limiter);
      limiter.connect(context.destination);
      return bus;
    }

    /**
     * The selectable completion tones.
     *
     * Every entry is the same shape — three events, each a list of notes plus an
     * optional per-tone voicing — so a new tone is data, not code. The user picks
     * which one the pet plays; the choice persists, and every tone is audible
     * from the panel's preview control. Deliberately distinct in character so the
     * pick is a real choice rather than a variation.
     */
    const TONES = {
      bright: {
        label: '明亮铃音 Bright（音频文件）',
        hint: '播放 assets/tone.wav,替换该文件即可换音',
        source: 'asset',
        done: [
          { frequency: 523.25, duration: 0.5 },
          { frequency: 659.25, duration: 0.5, gain: 0.92 },
          { frequency: 783.99, duration: 0.62, gain: 0.85 },
          { frequency: 1046.5, duration: 0.85, gain: 0.6 },
        ],
        failed: [
          { frequency: 622.25, duration: 0.34 },
          { frequency: 466.16, duration: 0.6, gain: 0.95 },
          { frequency: 349.23, duration: 0.9, gain: 0.8 },
        ],
        start: [{ frequency: 1318.51, duration: 0.1, gain: 0.4 }],
      },
      soft: {
        label: '柔和木琴 Soft',
        hint: '纯正弦,弱起音,安静',
        source: 'synth',
        octave: 1.5,
        shimmer: 0.1,
        master: 0.8,
        done: [
          { frequency: 587.33, duration: 0.55, gain: 0.8 },
          { frequency: 880, duration: 0.75, gain: 0.62 },
        ],
        failed: [
          { frequency: 440, duration: 0.5, gain: 0.75 },
          { frequency: 329.63, duration: 0.85, gain: 0.6 },
        ],
        start: [{ frequency: 880, duration: 0.12, gain: 0.35 }],
      },
      marimba: {
        label: '木质马林巴 Marimba',
        hint: '方形波,短促干脆',
        source: 'synth',
        type: 'square',
        shimmer: 0.12,
        master: 0.62,
        done: [
          { frequency: 523.25, duration: 0.22 },
          { frequency: 783.99, duration: 0.34, gain: 0.8 },
        ],
        failed: [
          { frequency: 392, duration: 0.3, gain: 0.85 },
          { frequency: 261.63, duration: 0.45, gain: 0.7 },
        ],
        start: [{ frequency: 1046.5, duration: 0.08, gain: 0.4 }],
      },
      click: {
        label: '轻点提示 Click',
        hint: '单音极简,最不打扰',
        source: 'synth',
        type: 'triangle',
        shimmer: 0.08,
        master: 0.75,
        done: [
          { frequency: 880, duration: 0.18 },
          { frequency: 1174.66, duration: 0.3, gain: 0.7 },
        ],
        failed: [{ frequency: 349.23, duration: 0.35, gain: 0.9 }],
        start: [{ frequency: 1318.51, duration: 0.06, gain: 0.35 }],
      },
      bell: {
        label: '长尾钟声 Bell',
        hint: '慢起音,余韵悠长',
        source: 'synth',
        type: 'triangle',
        octave: 2.5,
        shimmer: 0.28,
        master: 0.7,
        attack: 0.035,
        done: [
          { frequency: 523.25, duration: 1.1 },
          { frequency: 783.99, duration: 1.4, gain: 0.55 },
        ],
        failed: [{ frequency: 392, duration: 1.2, gain: 0.8 }],
        start: [{ frequency: 1046.5, duration: 0.14, gain: 0.3 }],
      },
    };
    /** Default tone, used until the user picks another. */
    const DEFAULT_TONE = 'bright';
    /**
     * The permission alarm. Deliberately fixed rather than part of `TONES`: this
     * is a safety cue, so it must not become the quiet "Click" because that was
     * the selected completion sound. A fast high/low square alternation reads as
     * an alarm even at low volume, and the last rising note resolves it.
     */
    const URGENT_NOTES = [
      { frequency: 987.77, duration: 0.16, gain: 1, type: 'square' },
      { frequency: 659.25, duration: 0.16, gain: 1, type: 'square' },
      { frequency: 987.77, duration: 0.16, gain: 1, type: 'square' },
      { frequency: 659.25, duration: 0.16, gain: 1, type: 'square' },
      { frequency: 1318.51, duration: 0.46, gain: 0.92, type: 'square' },
    ];
    const URGENT_VOICING = { type: 'square', gain: 1.3, octave: 1.5, shimmer: 0.12, attack: 0.004 };
    /** Persisted tone choice. */
    const TONE_KEY = `${STORAGE_KEY}.tone`;

    /** Read the chosen tone name, tolerating absent or corrupt storage. */
    function readTone() {
      try {
        const stored = window.localStorage.getItem(TONE_KEY);
        if (typeof stored === 'string' && TONES[stored] !== undefined) return stored;
      } catch {
        /* fall through to the default */
      }
      return DEFAULT_TONE;
    }

    /** Where the Host serves this package's tone asset. */
    const TONE_URL = '/pet-whale/assets/tone.wav';

    /**
     * Lazily created context plus the cue API.
     *
     * Browsers refuse to start audio before a user gesture, so the context is
     * created on demand and resumed on the first `pointerdown` / `keydown`.
     * `getState()` is the only reliable signal available for that.
     *
     * The cue itself is a file (`assets/tone.wav`) rather than synthesized notes,
     * so the sound can be replaced without touching code. The WAV form is kept
     * deliberately: it is the one container every browser decodes without a
     * license, and it is small once downmixed to 24 kHz mono. Synthesized notes
     * remain as the fallback, so a missing or undecodable asset still makes a
     * sound instead of silence.
     */
    const audio = {
      context: undefined,
      bus: undefined,
      unavailable: false,
      /** Decoded tone buffer, or a marker that loading already failed. */
      buffer: undefined,
      bufferState: 'idle',
      /** Create the context and output stage on first use, or record that audio is off. */
      ensure() {
        if (this.unavailable) return undefined;
        if (this.context !== undefined) return this.context;
        const Ctor = window.AudioContext ?? window.webkitAudioContext;
        if (typeof Ctor !== 'function') {
          this.unavailable = true;
          return undefined;
        }
        try {
          this.context = new Ctor();
          this.bus = chimeOutput(this.context, (TONES[this.toneName]?.master ?? 1) * CHIME_MASTER);
        } catch {
          this.unavailable = true;
          return undefined;
        }
        return this.context;
      },
      /** Resume a context the autoplay policy suspended; safe to call repeatedly. */
      unlock() {
        const context = this.ensure();
        if (context !== undefined && context.state === 'suspended') {
          context.resume().catch(() => {});
        }
      },
      /**
       * Play one note sequence.
       *
       * The autoplay policy is the main reason a correctly built chime can still
       * be inaudible: a freshly created context starts `suspended` in some
       * browsers, and scheduling notes into a suspended context plays nothing at
       * all. So the context is resumed FIRST and the notes are only scheduled
       * once it reports `running`; the resume is awaited rather than fired and
       * forgotten, which is what removes that race.
       *
       * @param notes - the note data to schedule.
       * @returns the ring-out in seconds, or undefined when audio is unavailable.
       */
      play(notes, voicing) {
        const context = this.ensure();
        if (context === undefined) return undefined;
        const schedule = () => {
          const start = context.currentTime + 0.02;
          // Every rendered note must be attached to the output, and a note IS its
          // own node: `renderChime` returns one envelope per note. Leaving them
          // unattached is completely silent — no error, no warning, nothing in
          // the graph — which is how four of the five tones ended up mute while
          // the asset path (which connects explicitly) still played.
          const bus = this.bus ?? context.destination;
          const sources = renderChime(context, notes, start, voicing);
          if (Array.isArray(sources)) {
            for (const node of sources) {
              if (node !== null && typeof node?.connect === 'function') node.connect(bus);
            }
          }
          return ringOut(notes, start);
        };
        if (context.state === 'running') return schedule();
        if (typeof context.resume !== 'function') return undefined;
        try {
          const resumed = context.resume();
          if (resumed !== null && typeof resumed?.then === 'function') {
            return resumed.then(schedule, () => undefined);
          }
        } catch {
          return undefined;
        }
        // No promise to await: schedule anyway rather than dropping the cue.
        return schedule();
      },
      /** The selected tone's note data and voicing. */
      tone() {
        return TONES[this.toneName] ?? TONES[DEFAULT_TONE];
      },
      toneName: readTone(),
      /**
       * Switch the completion tone.
       *
       * The output stage is rebuilt because a tone carries its own trim; the old
       * bus is dropped so the change is immediate rather than additive.
       */
      setTone(name) {
        if (TONES[name] === undefined) return;
        this.toneName = name;
        try {
          window.localStorage.setItem(TONE_KEY, name);
        } catch {
          /* the choice simply will not persist */
        }
        const context = this.context;
        if (context === undefined) return;
        try {
          this.bus = chimeOutput(context, (TONES[name].master ?? 1) * CHIME_MASTER);
        } catch {
          /* keep the existing stage rather than losing audio */
        }
      },
      /**
       * Load and decode the tone asset, once.
       *
       * Fire-and-forget by design: the caller plays synthesized notes while this
       * is in flight, so the first cue is never delayed by a fetch. A failure is
       * recorded rather than retried on every cue.
       */
      loadTone() {
        const context = this.ensure();
        if (context === undefined) return undefined;
        if (this.bufferState !== 'idle') return undefined;
        this.bufferState = 'loading';
        return Promise.resolve()
          .then(() => fetch(TONE_URL, { credentials: 'same-origin' }))
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.arrayBuffer();
          })
          .then((bytes) => context.decodeAudioData(bytes))
          .then((decoded) => {
            this.buffer = decoded;
            this.bufferState = 'ready';
            return decoded;
          })
          .catch((error) => {
            this.bufferState = 'failed';
            console.warn?.(`[${'dsh-pet-whale'}] tone asset unavailable, using the synthesized cue:`, error);
            return undefined;
          });
      },
      /** Play the decoded asset, if there is one. */
      playAsset() {
        const context = this.context;
        const buffer = this.buffer;
        if (context === undefined || buffer === undefined) return undefined;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.bus ?? context.destination);
        source.start();
        return buffer.duration;
      },
      done() {
        const tone = this.tone();
        // Route by the tone's declared source. Preferring the asset for every
        // tone is what made all five choices play one identical cached buffer;
        // the picker only means something if it changes the sound.
        if (tone.source === 'asset') {
          const played = this.playAsset();
          if (played !== undefined) return played;
          // Not decoded yet (or unavailable): kick the load and use the notes, so
          // the first cue is not delayed by a fetch and never goes silent.
          this.loadTone();
        }
        return this.play(tone.done, tone);
      },
      failed() {
        // The asset carries only the success sound, so a failure stays synthesized
        // and takes the selected tone's downward shape.
        const tone = this.tone();
        return this.play(tone.failed, tone);
      },
      start() {
        const tone = this.tone();
        return this.play(tone.start, tone);
      },
      /**
       * The permission cue.
       *
       * It uses a fixed urgent pattern instead of the selected completion tone:
       * an approval waiting on a human is a different class of event, and the
       * user may well have chosen a quiet completion sound. The output stage is
       * shared, so this still respects the global mute switch and limiter.
       */
      urgent() {
        return this.play(URGENT_NOTES, URGENT_VOICING);
      },
    };

    // Exposed only under an explicit flag, so the shipping bundle exports nothing
    // extra while `tools/chime-test.mjs` can still reach the real functions.
    if (globalThis.__PET_WHALE_TEST__ === true) {
      globalThis.__PET_WHALE_AUDIO__ = {
        renderVoice, renderChime, chimeOutput, TONES, DEFAULT_TONE, VOICE_GAIN, CHIME_MASTER, NOTE_GAP,
        URGENT_NOTES, URGENT_VOICING,
      };
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const STYLES = `
.${PREFIX}-root{position:fixed;right:22px;bottom:20px;z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:10px;font-family:inherit;color:var(--dsw-alias-label-primary,#1b1b1f);-webkit-user-select:none;user-select:none}
.${PREFIX}-lyr{position:relative;width:96px;height:88px;display:block;cursor:pointer;border:0;padding:0;background:transparent;color:inherit;animation:${PREFIX}-float 5.2s ease-in-out infinite}
.${PREFIX}-lyr:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:6px;border-radius:16px}
.${PREFIX}-lyr[data-busy="1"]{animation-duration:2.1s}
.${PREFIX}-whale{width:96px;height:88px;display:block;overflow:visible;filter:drop-shadow(0 8px 18px rgba(45,86,220,.28))}
.${PREFIX}-orbit{transform-box:view-box;animation:${PREFIX}-bobY 3.4s ease-in-out infinite}
.${PREFIX}-body{transform-box:fill-box;transform-origin:50% 60%;animation:${PREFIX}-bob 3.4s ease-in-out infinite}
.${PREFIX}-lyr[data-busy="1"] .${PREFIX}-orbit{animation-duration:1.15s}
.${PREFIX}-lyr[data-busy="1"] .${PREFIX}-body{animation-duration:1.15s}
.${PREFIX}-edge{pointer-events:none}
.${PREFIX}-bub{transform-box:fill-box;transform-origin:50% 50%;animation:${PREFIX}-rise 2.9s ease-out infinite;opacity:0}
.${PREFIX}-bub2{animation-delay:.9s}
.${PREFIX}-bub3{animation-delay:1.8s}
.${PREFIX}-ring{transform-box:fill-box;transform-origin:50% 50%;animation:${PREFIX}-spin 1.6s linear infinite;opacity:0;transition:opacity .25s ease}
.${PREFIX}-lyr[data-busy="1"] .${PREFIX}-ring{opacity:.9}
.${PREFIX}-glow{opacity:0;transition:opacity .4s ease}
.${PREFIX}-lyr[data-busy="1"] .${PREFIX}-glow{opacity:.5;animation:${PREFIX}-pulse 1.9s ease-in-out infinite}
/* Completion flash: a distinct celebratory pulse, so the end of work is
   unmistakable even with sound muted or the tab in the background. */
.${PREFIX}-lyr[data-mood="done"] .${PREFIX}-glow{opacity:.95;animation:${PREFIX}-flash .9s ease-out 2}
.${PREFIX}-lyr[data-mood="error"] .${PREFIX}-glow{opacity:.9;animation:${PREFIX}-flash 1.1s ease-out 1;fill:var(--dsw-alias-state-error-primary,#e5484d)}
/* A pending permission is a blocking state: the whale's own blue halo blinks
   until it is answered. Keep the gradient rather than a solid warning color so
   it still reads as part of the whale; the pulse, not the hue, carries urgency. */
.${PREFIX}-lyr[data-approval="1"] .${PREFIX}-glow{opacity:.9;animation:${PREFIX}-flash 1.1s ease-out infinite;fill:url(#${PREFIX}-glow)}
/* Completion spout. It leaves the blowhole, which is the V-notch in the back
   profile: measured on the outline, x 12.45 is where the back drops from y 0.66
   to y 2.96, and 2.96 is the notch vertex. Emitting from the high arm instead put
   the water on the fluke stock, so the origin is the vertex. The strand is drawn
   around a local origin so the keyframes can throw it upward. */
.${PREFIX}-spout{transform-box:view-box;transform-origin:12.45px 2.9px;opacity:0}
.${PREFIX}-lyr[data-mood="done"] .${PREFIX}-spout{animation:${PREFIX}-spout 1.5s cubic-bezier(.2,.7,.3,1) 1}
@keyframes ${PREFIX}-bob{0%,100%{transform:translateY(0) rotate(-1.2deg)}50%{transform:translateY(-7px) rotate(1.2deg)}}
/* The orbit follows only the vertical half of the bob: the ring keeps its own
   spin, and the halo stays concentric instead of inheriting the body's sway. */
@keyframes ${PREFIX}-bobY{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
@keyframes ${PREFIX}-rise{0%{transform:translateY(6px) scale(.4);opacity:0}25%{opacity:.85}100%{transform:translateY(-26px) scale(1.15);opacity:0}}
@keyframes ${PREFIX}-spin{to{transform:rotate(360deg)}}
@keyframes ${PREFIX}-pulse{0%,100%{opacity:.28}50%{opacity:.6}}
@keyframes ${PREFIX}-flash{0%{opacity:.25}35%{opacity:1}100%{opacity:.2}}
@keyframes ${PREFIX}-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
/* A short burst up and outward, then a quick fade as it falls back. */
@keyframes ${PREFIX}-spout{0%{opacity:0;transform:scaleY(.15) translateY(0)}12%{opacity:1}45%{opacity:1;transform:scaleY(1) translateY(0)}100%{opacity:0;transform:scaleY(1.12) translateY(-1.4px)}}
@keyframes ${PREFIX}-slide{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
.${PREFIX}-panel{width:390px;max-width:min(92vw,390px);max-height:min(90vh,860px);display:flex;flex-direction:column;min-height:0;overflow:hidden;border-radius:14px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:var(--dsw-alias-bg-overlay,#fff);box-shadow:0 18px 48px rgba(16,24,48,.24);animation:${PREFIX}-slide .22s ease-out}
.${PREFIX}-head{display:flex;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));flex:none}
/* The scrolling region. Everything between the pinned header and footer lives
   here and scrolls as one surface, which is what keeps the footer inside the
   panel: sizing the RECORD LIST as the flexible child instead let its automatic
   minimum push the total content past the panel's max-height, and the footer was
   clipped away. An explicit min-height:0 is required, or the auto floor returns. */
.${PREFIX}-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.${PREFIX}-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#9aa4b8);flex:none}
.${PREFIX}-dot[data-busy="1"]{background:#4d6bfe;animation:${PREFIX}-pulse 1.4s ease-in-out infinite}
.${PREFIX}-title{font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${PREFIX}-status{padding:11px 13px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));display:flex;flex-direction:column;gap:4px;flex:none}
.${PREFIX}-statusline{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px}
.${PREFIX}-approval{margin-top:4px;padding:5px 7px;border-radius:6px;border-left:2px solid var(--dsw-alias-state-warn-primary,#e0a11b);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a11b) 14%,transparent);display:flex;flex-direction:column;gap:3px}
.${PREFIX}-approvalrow{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-primary,#1b1b1f);word-break:break-word}
.${PREFIX}-approvalrow b{color:var(--dsw-alias-state-warn-primary,#e0a11b)}
.${PREFIX}-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
// The record list is a plain block inside the scrolling body. A moderate floor
// keeps a row or two readable when the sections above are tall, without letting
// the list dictate the panel's height.
.${PREFIX}-list{padding:5px 0;min-height:220px}
.${PREFIX}-row{display:flex;gap:9px;padding:8px 13px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));transition:background .15s ease}
.${PREFIX}-row[data-clickable="1"]{cursor:pointer}
.${PREFIX}-row[data-clickable="1"]:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04))}
.${PREFIX}-row[data-clickable="1"]:focus-visible{outline:2px solid #4d6bfe;outline-offset:-2px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04))}
.${PREFIX}-openmark{margin-left:auto;font-size:11px;line-height:1;opacity:.55;color:var(--dsw-alias-label-secondary,#6b7280)}
.${PREFIX}-row:last-child{border-bottom:0}
.${PREFIX}-rail{width:2px;border-radius:1px;background:#4d6bfe;opacity:.55;flex:none}
.${PREFIX}-row[data-error="1"] .${PREFIX}-rail{background:var(--dsw-alias-state-error-primary,#e5484d);opacity:.85}
.${PREFIX}-rowmain{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.${PREFIX}-meta{display:flex;align-items:baseline;gap:7px;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}
.${PREFIX}-seq{font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-label-primary,#1b1b1f)}
.${PREFIX}-prompt{font-size:12.5px;line-height:1.45;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.${PREFIX}-muted{color:var(--dsw-alias-label-secondary,#6b7280);font-style:italic}
.${PREFIX}-reply{font-size:11.5px;line-height:1.42;color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.${PREFIX}-tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:1px}
.${PREFIX}-tag{font-size:10.5px;line-height:15px;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#6b7280);font-variant-numeric:tabular-nums}
.${PREFIX}-tag[data-warn="1"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 16%,transparent);color:var(--dsw-alias-state-error-primary,#e5484d)}
.${PREFIX}-empty{padding:24px 16px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.7}
.${PREFIX}-acct{border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));padding:9px 13px 11px;display:flex;flex-direction:column;gap:3px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.02));flex:none}
/* Context card, fed by the harness' token-meter projections and (when present)
   dsh-context's contextTimeline. Kept visually lighter than the accounting
   block: one bar, one legend, four numbers, one jump link. */
.${PREFIX}-ctx{border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));padding:9px 13px 11px;display:flex;flex-direction:column;gap:3px;flex:none}
.${PREFIX}-ctxpct{font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ctx-ink,#4d6bfe)}
.${PREFIX}-ctxpct[data-level="warn"]{--ctx-ink:var(--dsw-alias-state-warn-primary,#b77900)}
.${PREFIX}-ctxpct[data-level="critical"]{--ctx-ink:var(--dsw-alias-state-error-primary,#e5484d)}
.${PREFIX}-ctxbar{display:flex;height:8px;border-radius:99px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.07));margin:3px 0 5px;gap:1px}
.${PREFIX}-ctxseg{display:block;height:100%;min-width:0;transition:width .35s ease}
.${PREFIX}-ctxseg[data-part="system"]{background:#4d6bfe}
.${PREFIX}-ctxseg[data-part="tools"]{background:#7b61ff}
.${PREFIX}-ctxseg[data-part="messages"]{background:var(--dsw-alias-state-success-primary,#21a26b)}
.${PREFIX}-ctxseg[data-part="injected"]{background:var(--dsw-alias-state-warn-primary,#e0a11b)}
.${PREFIX}-ctxseg[data-part="other"]{background:var(--dsw-alias-state-idle-primary,#9aa4b8)}
.${PREFIX}-ctxseg[data-part="free"]{flex:1 1 auto;background:transparent}
.${PREFIX}-ctxlegend{display:flex;flex-wrap:wrap;gap:3px 10px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#6b7280);margin-bottom:2px}
.${PREFIX}-ctxitem{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.${PREFIX}-ctxdot{width:6px;height:6px;border-radius:2px;background:#9aa4b8;flex:none}
.${PREFIX}-ctxdot[data-part="system"]{background:#4d6bfe}
.${PREFIX}-ctxdot[data-part="tools"]{background:#7b61ff}
.${PREFIX}-ctxdot[data-part="messages"]{background:var(--dsw-alias-state-success-primary,#21a26b)}
.${PREFIX}-ctxdot[data-part="injected"]{background:var(--dsw-alias-state-warn-primary,#e0a11b)}
.${PREFIX}-ctxwarn{margin-top:4px;padding:5px 7px;border-radius:6px;font-size:11px;line-height:1.5;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0a11b) 15%,transparent);color:var(--dsw-alias-label-primary,#1b1b1f);border-left:2px solid var(--dsw-alias-state-warn-primary,#e0a11b)}
.${PREFIX}-ctxwarn[data-level="critical"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 14%,transparent);border-left-color:var(--dsw-alias-state-error-primary,#e5484d)}
.${PREFIX}-ctxfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;flex-wrap:wrap}
.${PREFIX}-ctxfoot .${PREFIX}-note{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.${PREFIX}-ctxfoot .${PREFIX}-btn{flex:none}
.${PREFIX}-secthead{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;font-weight:600;margin-bottom:4px}
.${PREFIX}-secthead .${PREFIX}-note{font-weight:400}
.${PREFIX}-sesslabel{font-size:10.5px;color:var(--dsw-alias-label-secondary,#6b7280);margin:-2px 0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${PREFIX}-sectsub{font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);margin:7px 0 2px;letter-spacing:.02em}
.${PREFIX}-kv{display:grid;grid-template-columns:1fr auto auto;align-items:baseline;gap:8px;font-size:11.5px;line-height:1.5}
.${PREFIX}-k{color:var(--dsw-alias-label-secondary,#6b7280);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${PREFIX}-v{font-variant-numeric:tabular-nums;font-weight:600}
.${PREFIX}-kv .${PREFIX}-note{font-variant-numeric:tabular-nums;min-width:62px;text-align:right}
.${PREFIX}-kvtot{margin-top:3px;padding-top:4px;border-top:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.12));font-size:12.5px}
.${PREFIX}-acctnote{margin-top:5px;line-height:1.55;text-align:left;white-space:normal}
.${PREFIX}-sel{font:inherit;font-size:11px;padding:2px 5px;border-radius:6px;max-width:150px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1b1b1f)}
.${PREFIX}-sels{display:flex;align-items:center;gap:5px;flex:none}
.${PREFIX}-sels .${PREFIX}-sel{max-width:96px}
.${PREFIX}-empty2{padding:12px 2px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.6}
.${PREFIX}-pending{margin:2px 0 4px;padding:4px 7px;border-radius:6px;font-size:11px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#6b7280)}
.${PREFIX}-foot{display:flex;align-items:center;gap:8px;padding:8px 11px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));flex:none}
.${PREFIX}-btn{font:inherit;font-size:11.5px;padding:4px 10px;border-radius:7px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1b1b1f)}
.${PREFIX}-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04))}
.${PREFIX}-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}
.${PREFIX}-grow{flex:1}
.${PREFIX}-note{font-size:10.5px;color:var(--dsw-alias-label-secondary,#6b7280)}
@media (prefers-reduced-motion:reduce){.${PREFIX}-lyr,.${PREFIX}-orbit,.${PREFIX}-body,.${PREFIX}-bub,.${PREFIX}-ring,.${PREFIX}-glow,.${PREFIX}-spout,.${PREFIX}-panel{animation:none!important}}
`;

    /** Insert the stylesheet as a React element, so unmounting removes it. */
    function Stylesheet() {
      return h('style', { 'data-plugin': PREFIX }, STYLES);
    }

    /* ------------------------------------------------------------------ *
     * The whale
     * ------------------------------------------------------------------ */

    /**
     * The whale mark. `busy` drives the working animation.
     *
     * **Draw exactly one path — the official one.** `FISH_LOGO_PATH` is the
     * complete DeepSeek silhouette (flipper, fluke and all), and an earlier
     * revision of this component wrecked it by compositing shapes of its own
     * invention on top: a hand-written "specular highlight" polygon and a second
     * tail fin. Both landed inside the body and produced a white blob over the
     * whale. The official mark is a single filled shape; the only additions that
     * belong are a halo *behind* it and strokes *on its outline*.
     */
    function Whale({ busy, mood }) {
      return h(
        'svg',
        {
          className: `${PREFIX}-whale`,
          viewBox: '-2 -3 27.5 25.5',
          role: 'img',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: `${PREFIX}-grad`, x1: '2', y1: '1', x2: '22', y2: '17', gradientUnits: 'userSpaceOnUse' },
            h('stop', { offset: '0', stopColor: '#6D93FF' }),
            h('stop', { offset: '.52', stopColor: '#4D6BFE' }),
            h('stop', { offset: '1', stopColor: '#2B3FD6' }),
          ),
          h(
            'radialGradient',
            { id: `${PREFIX}-glow`, cx: '.5', cy: '.5', r: '.5' },
            h('stop', { offset: '0', stopColor: '#7BA0FF', stopOpacity: '.85' }),
            h('stop', { offset: '1', stopColor: '#7BA0FF', stopOpacity: '0' }),
          ),
        ),
        // Behind the body only: the halo and the dashed working ring share one
        // bob wrapper, so the light follows the whale's vertical motion instead
        // of hanging in place while the body swims through it.
        h(
          'g',
          { className: `${PREFIX}-orbit` },
          h('circle', { className: `${PREFIX}-glow`, cx: '11.5', cy: '9', r: '12.5', fill: `url(#${PREFIX}-glow)` }),
          // Working ring: a dashed arc orbiting the mark, outside the silhouette.
          h('circle', {
            className: `${PREFIX}-ring`,
            cx: '11.5',
            cy: '8.5',
            r: '14.2',
            fill: 'none',
            stroke: '#4D6BFE',
            strokeWidth: '0.7',
            strokeLinecap: 'round',
            strokeDasharray: '5 44',
          }),
        ),
        h(
          'g',
          { className: `${PREFIX}-body` },
          // The whale. One path, official geometry, nothing composited on top.
          h('path', { d: WHALE_PATH, fill: `url(#${PREFIX}-grad)` }),
          // Depth: the SAME geometry stroked with a light blue. It traces the
          // boundary and the logo's interior details without inventing any shape,
          // which is what keeps it from covering the body. The official mark
          // already renders those details insetted like this, so the inset look
          // is faithful rather than decorative.
          h('path', {
            className: `${PREFIX}-edge`,
            d: WHALE_PATH,
            fill: 'none',
            stroke: '#9DB8FF',
            strokeWidth: '0.36',
            strokeLinejoin: 'round',
            opacity: '.55',
          }),
        ),
        // The completion spout, in the blowhole notch. Hidden unless `mood` is
        // 'done'. Anchored at the notch vertex (12.45, 2.9) and sized to read at
        // the 96px render: a plume shorter than the fluke disappears at panel
        // scale, and a thin one reads as an antenna rather than as water.
        h(
          'g',
          { className: `${PREFIX}-spout`, fill: '#8FB4FF' },
          // The central plume: a lobe that widens as it rises.
          h('path', {
            d: 'M12.45 2.9C11.5 1.2 11.35 -0.6 12.45 -1.9C13.55 -0.6 13.4 1.2 12.45 2.9Z',
            opacity: '.95',
          }),
          // Side fans, so it reads as a spray rather than a spike.
          h('path', { d: 'M12.45 2.9C11.35 2.5 10.2 1.9 9.2 1.1C10.3 1.4 11.5 2.1 12.45 2.9Z', opacity: '.72' }),
          h('path', { d: 'M12.45 2.9C13.55 2.5 14.7 1.9 15.7 1.1C14.6 1.4 13.4 2.1 12.45 2.9Z', opacity: '.72' }),
          // Droplets flung clear of the plume.
          h('circle', { cx: '11.15', cy: '0.1', r: '0.34', opacity: '.85' }),
          h('circle', { cx: '13.75', cy: '-0.25', r: '0.28', opacity: '.75' }),
          h('circle', { cx: '12.45', cy: '-2.4', r: '0.26', opacity: '.7' }),
          h('circle', { cx: '11.6', cy: '-1.5', r: '0.18', opacity: '.6' }),
        ),
        // Rising bubbles, clipped clear of the silhouette so they read as water
        // rather than as marks on the whale.
        h('circle', { className: `${PREFIX}-bub`, cx: '2.2', cy: '12.4', r: '0.8', fill: '#7BA0FF', opacity: '.65' }),
        h('circle', { className: `${PREFIX}-bub ${PREFIX}-bub2`, cx: '1.4', cy: '9.2', r: '0.55', fill: '#9DB8FF', opacity: '.6' }),
        h('circle', { className: `${PREFIX}-bub ${PREFIX}-bub3`, cx: '2.9', cy: '15.6', r: '0.5', fill: '#9DB8FF', opacity: '.6' }),
      );
    }

    /* ------------------------------------------------------------------ *
     * The panel
     * ------------------------------------------------------------------ */

    /** One ledger row. A row with a session can be activated to open it. */
    function RecordRow({ record, index, onOpen }) {
      const hasError = typeof record.error === 'string' && record.error !== '';
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
      const canOpen = sessionId !== '' && typeof onOpen === 'function';
      const open = () => {
        if (canOpen) onOpen(record);
      };
      return h(
        'div',
        {
          className: `${PREFIX}-row`,
          'data-error': hasError ? '1' : undefined,
          'data-clickable': canOpen ? '1' : undefined,
          role: canOpen ? 'button' : undefined,
          tabIndex: canOpen ? 0 : undefined,
          onClick: canOpen ? open : undefined,
          onKeyDown: canOpen
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  open();
                }
              }
            : undefined,
          title: canOpen ? `打开对应对话 · Open ${record.label ?? 'conversation'}` : undefined,
          'aria-label': canOpen ? `Open conversation ${record.label ?? sessionId}` : undefined,
        },
        h('div', { className: `${PREFIX}-rail` }),
        h(
          'div',
          { className: `${PREFIX}-rowmain` },
          h(
            'div',
            { className: `${PREFIX}-meta` },
            h('span', { className: `${PREFIX}-seq` }, `#${record.id ?? index + 1}`),
            h('span', null, clockTime(record.endedAt ?? record.startedAt ?? Date.now())),
            h('span', null, duration(record.durationMs)),
            record.origin === 'local' ? h('span', { className: `${PREFIX}-tag` }, 'local') : null,
            canOpen ? h('span', { className: `${PREFIX}-openmark`, 'aria-hidden': 'true' }, '↗') : null,
          ),
          record.prompt === '' || record.prompt === undefined
            ? h('div', { className: `${PREFIX}-prompt ${PREFIX}-muted` }, '（未采集到提示词 · prompt not captured）')
            : h('div', { className: `${PREFIX}-prompt` }, record.prompt),
          record.reply !== '' && record.reply !== undefined
            ? h('div', { className: `${PREFIX}-reply` }, record.reply)
            : null,
          hasError ? h('div', { className: `${PREFIX}-reply`, style: { color: 'var(--dsw-alias-state-error-primary,#e5484d)' } }, record.error) : null,
          h(
            'div',
            { className: `${PREFIX}-tags` },
            record.label !== undefined && record.label !== '' ? h('span', { className: `${PREFIX}-tag` }, record.label) : null,
            h('span', { className: `${PREFIX}-tag` }, `${record.tools ?? 0} tools`),
            h('span', { className: `${PREFIX}-tag` }, `${record.turns ?? 0} turns`),
            h('span', { className: `${PREFIX}-tag` }, `${record.steps ?? 0} steps`),
            record.prompt !== undefined && record.prompt !== ''
              ? h('span', { className: `${PREFIX}-tag` }, `${glyphs(record.prompt)} glyphs`)
              : null,
          ),
        ),
      );
    }

    /**
     * The context card: how full the window is, what fills it, and what changed.
     *
     * The occupancy number is the harness' own `contextPressure` figure — the
     * same one the composer's ring warns on — while the composition and the
     * compaction/prune counters come from dsh-context's `contextTimeline` when
     * that plugin is installed. With dsh-context present the card also jumps to
     * its Context Insights page; without it, the official projections still
     * drive this card, so the pet never depends on a second plugin.
     */
    function ContextSection({ context, onOpenInsights }) {
      if (context === undefined) {
        return h(
          'div',
          { className: `${PREFIX}-ctx` },
          h(
            'div',
            { className: `${PREFIX}-secthead` },
            h('span', null, '上下文 Context'),
            h('span', { className: `${PREFIX}-note` }, '等待投影…'),
          ),
          h(
            'div',
            { className: `${PREFIX}-empty2` },
            '暂无上下文投影。打开一个会话后，这里会显示窗口占用与构成。',
            h('br'),
            h('span', { className: `${PREFIX}-note` }, 'No context projection yet — open a session to populate it.'),
          ),
        );
      }

      const pct = context.ratio === undefined ? undefined : context.ratio * 100;
      const pctText = pct === undefined ? '—' : `${pct.toFixed(1)}%`;
      const totalForBar = Math.max(context.used, context.accounted, 1);
      const share = (value) => (totalForBar > 0 ? `${Math.max(0, Math.min(100, (value / totalForBar) * 100)).toFixed(1)}%` : '0%');
      const hitRate = context.inputSide > 0 ? Math.round((context.hit / context.inputSide) * 100) : undefined;
      const row = (label, value, note) =>
        h(
          'div',
          { className: `${PREFIX}-kv` },
          h('span', { className: `${PREFIX}-k` }, label),
          h('span', { className: `${PREFIX}-v` }, value),
          h('span', { className: `${PREFIX}-note` }, note ?? ''),
        );

      return h(
        'div',
        { className: `${PREFIX}-ctx` },
        h(
          'div',
          { className: `${PREFIX}-secthead` },
          h('span', null, '上下文 Context'),
          h('span', { className: `${PREFIX}-ctxpct`, 'data-level': context.level }, pctText),
        ),
        h(
          'div',
          {
            className: `${PREFIX}-ctxbar`,
            role: 'img',
            'aria-label':
              context.ratio === undefined
                ? `Context composition ${compact(context.used)} tokens`
                : `Context ${pctText} full, ${compact(context.used)} of ${compact(context.window)} tokens`,
          },
          context.parts.map((part) =>
            h('span', {
              key: part.key,
              className: `${PREFIX}-ctxseg`,
              'data-part': part.key,
              style: { width: share(part.tokens) },
              title: `${part.label} · ${count(part.tokens)} tok · ${share(part.tokens)}`,
            }),
          ),
          h('span', { className: `${PREFIX}-ctxseg`, 'data-part': 'free' }),
        ),
        h(
          'div',
          { className: `${PREFIX}-ctxlegend` },
          context.parts.map((part) =>
            h(
              'span',
              { className: `${PREFIX}-ctxitem`, key: part.key },
              h('i', { className: `${PREFIX}-ctxdot`, 'data-part': part.key }),
              `${part.label} `,
              h('b', null, compact(part.tokens)),
            ),
          ),
        ),
        row(
          '窗口占用 Occupancy',
          pctText,
          context.window > 0 ? `${compact(context.used)} / ${compact(context.window)}` : `${compact(context.used)} tok`,
        ),
        context.window > 0
          ? row('剩余窗口 Headroom', compact(Math.max(0, context.window - context.used)), 'token')
          : null,
        context.reserve > 0
          ? row('预留输出 Reserve', compact(context.reserve), '下一个请求')
          : null,
        row(
          '压缩 Compactions',
          `${context.compactions} 次`,
          `${context.prunes} prune · ${context.turns} turns · ${context.steps} steps`,
        ),
        hitRate === undefined
          ? null
          : row('缓存命中 Cache hit', `${hitRate}%`, `${compact(context.hit)} / ${compact(context.inputSide)}`),
        context.level === 'warn' || context.level === 'critical'
          ? h(
              'div',
              { className: `${PREFIX}-ctxwarn`, 'data-level': context.level },
              context.level === 'critical'
                ? '⚠ 上下文已达到 90%，自动压缩可能随时触发。考虑 /compact 或新开一个会话。'
                : '上下文接近自动压缩阈值；留意这一轮的输入体积。',
            )
          : null,
        h(
          'div',
          { className: `${PREFIX}-ctxfoot` },
          h(
            'span',
            { className: `${PREFIX}-note` },
            context.source === 'dsh-context'
              ? `来源 dsh-context${context.model === undefined ? '' : ` · ${context.model}`}`
              : context.source === 'projection'
                ? '来源 官方 token 投影'
                : '来源 会话用量',
          ),
          context.hasTimeline && typeof onOpenInsights === 'function'
            ? h(
                'button',
                {
                  className: `${PREFIX}-btn`,
                  type: 'button',
                  onClick: onOpenInsights,
                  title: '在 dsh-context 的上下文洞察页查看完整构成、趋势与压缩事件',
                },
                '上下文洞察 Context Insights ↗',
              )
            : null,
        ),
      );
    }

    /**
     * The accounting block: what this session has cost and where the money went.
     *
     * `cost` is computed once per render from the Host snapshot's token buckets,
     * so the per-episode rows and the session total are priced by the same rule
     * and always agree.
     */
    function AccountSection({ session, records, todayRecords, requests, rate, model, models, table, currency, symbol, peak, balance, onModel, onCurrency }) {
      if (session === undefined || session.tokens === undefined) {
        return h(
          'div',
          { className: `${PREFIX}-acct` },
          h(
            'div',
            { className: `${PREFIX}-secthead` },
            h('span', null, '用量与花费 · Usage & cost'),
            h('span', { className: `${PREFIX}-note` }, '等待数据…'),
          ),
          h(
            'div',
            { className: `${PREFIX}-empty2` },
            '还没有可用的 token 数据。',
            h('br'),
            h('span', { className: `${PREFIX}-note` }, 'No token data yet — send a prompt, then reopen this panel.'),
          ),
        );
      }

      const t = session.tokens;
      const empty = tokensTotal(t) === 0;
      const hit = t.cacheReadTokens;
      const miss = t.inputTokens + t.cacheWriteTokens;
      const inputSide = hit + miss;
      const share = (value, whole) => (whole > 0 ? `${Math.round((value / whole) * 100)}%` : '0%');
      /** Sum of the recorded episode windows, excluding idle gaps between them. */
      const episodeMs = records.reduce(
        (sum, record) => sum + (typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? Math.max(0, record.durationMs) : 0),
        0,
      );

      /** Calendar-day rollup across all sessions the pet has records for. */
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const todayStart = dayStart.getTime();
      const today = (Array.isArray(todayRecords) ? todayRecords : records).filter((record) => {
        const at = typeof record.endedAt === 'number' ? record.endedAt : record.startedAt;
        return typeof at === 'number' && at >= todayStart;
      });
      const todayTokens = zeroTokens();
      const todayPeriods = { peak: zeroTokens(), off: zeroTokens() };
      for (const record of today) {
        const bucket = record.tokens;
        if (bucket !== null && typeof bucket === 'object') addBuckets(todayTokens, bucket);
        const recordPeriods = periodsFromRecords([record]);
        if (recordPeriods !== undefined) {
          addBuckets(todayPeriods.peak, recordPeriods.peak);
          addBuckets(todayPeriods.off, recordPeriods.off);
        } else if (bucket !== null && typeof bucket === 'object') {
          // No timestamp/periods at all: historical gap, count it as peak.
          addBuckets(todayPeriods.peak, bucket);
        }
      }
      const todayBilled = tokensTotal(todayTokens);
      const todayCost = pricePeriods(todayPeriods, table, model) ?? priceTokens(todayTokens, rate);
      const hasPeriods = session.periods !== null && typeof session.periods === 'object';
      const peakRate = table?.models?.[model]?.peak ?? rate;
      const offRate = table?.models?.[model]?.offPeak ?? rate;
      // There is no third state: a token is either peak or off-peak. Tokens
      // without a recorded period are historical gaps; assign them to peak
      // (the conservative side) rather than inventing "unclassified".
      const classified = hasPeriods ? periodsTokens(session.periods) : zeroTokens();
      const unclassified = subtractBuckets(t, classified);
      const peakBucket = zeroTokens();
      if (hasPeriods) addBuckets(peakBucket, session.periods.peak);
      addBuckets(peakBucket, unclassified);
      const offBucket = zeroTokens();
      if (hasPeriods) addBuckets(offBucket, session.periods.off);
      const peakTokens = tokensTotal(peakBucket);
      const offTokens = tokensTotal(offBucket);
      const peakCost = priceTokens(peakBucket, peakRate);
      const offCost = priceTokens(offBucket, offRate);
      const shownCost = {
        cacheHitCost: peakCost.cacheHitCost + offCost.cacheHitCost,
        inputCost: peakCost.inputCost + offCost.inputCost,
        outputCost: peakCost.outputCost + offCost.outputCost,
        total: peakCost.total + offCost.total,
        split: true,
      };

      /** One label/value row inside the grid. */
      const row = (label, value, extra) =>
        h(
          'div',
          { className: `${PREFIX}-kv` },
          h('span', { className: `${PREFIX}-k` }, label),
          h('span', { className: `${PREFIX}-v` }, value),
          extra === undefined ? null : h('span', { className: `${PREFIX}-note` }, extra),
        );

      return h(
        'div',
        { className: `${PREFIX}-acct` },
        h(
          'div',
          { className: `${PREFIX}-secthead` },
          h('span', null, '用量与花费 · Usage & cost'),
          h(
            'div',
            { className: `${PREFIX}-sels` },
            h(
              'select',
              {
                className: `${PREFIX}-sel`,
                value: currency,
                onChange: (event) => onCurrency(event.target.value),
                'aria-label': 'Billing currency',
              },
              currencyOptions().map((option) => h('option', { key: option.key, value: option.key }, option.label)),
            ),
            h(
              'select',
              {
                className: `${PREFIX}-sel`,
                value: model,
                onChange: (event) => onModel(event.target.value),
                'aria-label': 'Pricing model',
              },
              Object.keys(models).map((key) => h('option', { key, value: key }, models[key].label)),
            ),
          ),
        ),
        h(
          'div',
          { className: `${PREFIX}-sesslabel` },
          `会话 · ${session.label !== undefined && session.label !== '' ? session.label : shortId(session.sessionId ?? '')}`,
        ),
        /* Even with no numbers yet the STRUCTURE is shown, so the block reads as
           "not settled yet" rather than "broken". provider usage only exists once
           a model step settles, which is why this can legitimately be zero while
           a reply is still streaming. */
        empty
          ? h(
              'div',
              { className: `${PREFIX}-pending` },
              '尚无结算数据 · awaiting the first settlement',
            )
          : null,
        h(
          'div',
          { className: `${PREFIX}-kv` },
          h('span', { className: `${PREFIX}-k` }, '会话年龄 Session age'),
          h('span', { className: `${PREFIX}-v` }, session.elapsedMs === undefined ? '—' : duration(session.elapsedMs)),
          h('span', { className: `${PREFIX}-note` }, '含空闲 · idle'),
        ),
        h(
          'div',
          { className: `${PREFIX}-kv` },
          h('span', { className: `${PREFIX}-k` }, '交互耗时 Episode time'),
          h('span', { className: `${PREFIX}-v` }, records.length === 0 ? '—' : duration(episodeMs)),
          h(
            'span',
            { className: `${PREFIX}-note` },
            records.length === 0 && session.totalTokens > 0
              ? '记录已滚出窗口'
              : `${Math.round(records.length)} 次交互${session.source === 'merged' ? ' · 记录窗口内' : ''}`,
          ),
        ),
        h(
          'div',
          { className: `${PREFIX}-kv` },
          h('span', { className: `${PREFIX}-k` }, '缓存命中率 Cache hit'),
          h('span', { className: `${PREFIX}-v` }, share(hit, inputSide)),
          h('span', { className: `${PREFIX}-note` }, `${count(hit)} / ${count(inputSide)}`),
        ),
        h(
          'div',
          { className: `${PREFIX}-kv` },
          h('span', { className: `${PREFIX}-k` }, '计费总 token Billed'),
          h('span', { className: `${PREFIX}-v` }, count(session.totalTokens)),
          h('span', { className: `${PREFIX}-note` }, `${count(requests || t.requests)} 次请求`),
        ),
        // Account balance: the wallets the Platform reports, in their own
        // currency, as a reference next to what this session has spent.
        balance === undefined
          ? null
          : h(
              'div',
              { className: `${PREFIX}-kv` },
              h('span', { className: `${PREFIX}-k` }, '账户余额 Balance'),
              h(
                'span',
                { className: `${PREFIX}-v` },
                balance.wallets.length === 0
                  ? '—'
                  : balance.wallets.map((wallet) => walletText(wallet)).join(' · '),
              ),
              h(
                'span',
                { className: `${PREFIX}-note` },
                balance.bonusWallets.length === 0
                  ? (balance.error === undefined ? '' : '读取失败')
                  : `赠送 ${balance.bonusWallets.map((wallet) => walletText(wallet)).join(' · ')}`,
              ),
            ),
        // Token buckets and their individual cost, so the split is visible rather
        // than only the sum.
        h('div', { className: `${PREFIX}-sectsub` }, 'Token 构成 · Breakdown'),
        [
          ['输入 · 缓存未命中 Cache miss', t.inputTokens, shownCost.inputCost],
          ['输入 · 缓存命中 Cache hit', t.cacheReadTokens, shownCost.cacheHitCost],
          ...(t.cacheWriteTokens > 0 ? [['缓存写入 Cache write（按 miss 计费）', t.cacheWriteTokens, undefined]] : []),
          ['输出 Output', t.outputTokens, shownCost.outputCost],
          ...(t.reasoningTokens > 0 ? [['　其中思维链 of which reasoning', t.reasoningTokens, undefined]] : []),
        ].map(([label, value, amount], index) =>
          h(
            'div',
            { className: `${PREFIX}-kv`, key: `${index}-${label}` },
            h('span', { className: `${PREFIX}-k` }, label),
            h('span', { className: `${PREFIX}-v` }, count(value)),
            h('span', { className: `${PREFIX}-note` }, amount === undefined ? '' : money(amount, symbol)),
          ),
        ),
        h('div', { className: `${PREFIX}-sectsub` }, '花费明细 · Cost'),
        row('输入侧 Input side', money(shownCost.inputCost, symbol), `miss ${symbol}${rate.miss}/M`),
        row('输出侧 Output', money(shownCost.outputCost, symbol), `${symbol}${rate.output}/M`),
        h(
          'div',
          { className: `${PREFIX}-kv ${PREFIX}-kvtot` },
          h('span', { className: `${PREFIX}-k` }, '合计 Total'),
          h('span', { className: `${PREFIX}-v` }, money(shownCost.total, symbol)),
          h(
            'span',
            { className: `${PREFIX}-note` },
            shownCost.split ? '忙时 + 闲时' : peak ? '高峰价 peak' : '低谷价 off-peak',
          ),
        ),
        h(
          'div',
          null,
          h('div', { className: `${PREFIX}-sectsub` }, '忙时 / 闲时 · Peak / off-peak'),
          h(
            'div',
            { className: `${PREFIX}-kv` },
            h('span', { className: `${PREFIX}-k` }, '忙时 token Peak'),
            h('span', { className: `${PREFIX}-v` }, count(peakTokens)),
            h('span', { className: `${PREFIX}-note` }, money(peakCost.total, symbol)),
          ),
          h(
            'div',
            { className: `${PREFIX}-kv` },
            h('span', { className: `${PREFIX}-k` }, '闲时 token Off-peak'),
            h('span', { className: `${PREFIX}-v` }, count(offTokens)),
            h('span', { className: `${PREFIX}-note` }, money(offCost.total, symbol)),
          ),
        ),
        h('div', { className: `${PREFIX}-sectsub` }, '今日用量 · Today'),
        h(
          'div',
          { className: `${PREFIX}-kv` },
          h('span', { className: `${PREFIX}-k` }, '今日计费 token Billed'),
          h('span', { className: `${PREFIX}-v` }, todayBilled > 0 ? count(todayBilled) : '—'),
          h('span', { className: `${PREFIX}-note` }, `${today.length} 次交互 · 跨会话`),
        ),
        h(
          'div',
          { className: `${PREFIX}-kv` },
          h('span', { className: `${PREFIX}-k` }, '今日估算费用 Estimated'),
          h('span', { className: `${PREFIX}-v` }, todayBilled > 0 ? money(todayCost.total, symbol) : '—'),
          h(
            'span',
            { className: `${PREFIX}-note` },
            '忙时 + 闲时',
          ),
        ),
        h(
          'div',
          { className: `${PREFIX}-note ${PREFIX}-acctnote` },
          '今日统计基于宠物保留的交互记录（最多 80 条），跨会话汇总；有峰/谷记录时按请求时段计价，缺失时段的按当前费率补估。',
        ),
        h(
          'div',
          { className: `${PREFIX}-note ${PREFIX}-acctnote` },
          `价格 ${models[model].label}（${table.label}）：缓存命中 ${symbol}${rate.hit}/M · 未命中 ${symbol}${rate.miss}/M · 输出 ${symbol}${rate.output}/M（每 1M token）`,
          h('br'),
          '高峰时段为北京时间周一至周五 09–12、14–18 点（即 UTC 01–04、06–10）；中国法定节假日按低谷计费，此处未扣除，因此节假日可能高估。',
          h('br'),
          '费用为本地费率估算；dsh-context 的 Context Stats 使用 models.dev 价目，估算结果可能与此处不同。',
          session.source === 'client'
            ? h('span', null, h('br'), '数据来源：浏览器会话投影（主机端尚未上报，因此没有分次明细与请求次数）。')
            : session.source === 'merged'
              ? h(
                  'span',
                  null,
                  h('br'),
                  session.periodsSource === 'context'
                    ? 'Token 与峰/谷分桶来自浏览器完整投影；交互明细为主机启动后记录。'
                    : session.periodsSource === 'records'
                      ? 'Token 来自浏览器完整投影；峰/谷分桶按交互记录时间估算，交互明细为主机启动后记录。'
                      : 'Token 来自浏览器完整会话投影；交互明细与峰/谷分桶为主机启动后记录，可能不完整。',
                )
              : null,
        ),
        records.length > 0
          ? h(
              'div',
              { className: `${PREFIX}-sectsub` },
              '每次交互 · Per interaction',
            )
          : null,
        records.slice(0, 12).map((record) => {
          const recordPeriods = periodsFromRecords([record]) ?? (record.tokens === undefined ? undefined : { peak: record.tokens, off: zeroTokens() });
          const splitRecord = record.tokens === undefined ? undefined : pricePeriods(recordPeriods, table, model);
          const recordCost = record.tokens === undefined
            ? undefined
            : splitRecord !== undefined && (splitRecord.total > 0 || tokensTotal(record.tokens) === 0)
              ? splitRecord
              : priceTokens(record.tokens, peakRate);
          return h(
            'div',
            { className: `${PREFIX}-kv`, key: `tok-${record.sessionId}-${record.startedAt}` },
            h(
              'span',
              { className: `${PREFIX}-k` },
              `#${record.id ?? '—'} ${clockTime(record.endedAt ?? record.startedAt ?? 0)}`,
            ),
            h(
              'span',
              { className: `${PREFIX}-v` },
              record.tokens === undefined ? '—' : count(tokensTotal(record.tokens)),
            ),
            h(
              'span',
              { className: `${PREFIX}-note` },
              recordCost === undefined
                ? ''
                : `${money(recordCost.total, symbol)} · ${duration(record.durationMs)}`,
            ),
          );
        }),
      );
    }

    /**
     * The expanded secondary page: what Harness is doing right now, and one row
     * per finished interaction.
     */
    function Panel({ view, records, onClear, onClose, soundOn, onToggleSound, onPreviewSound, onPickTone, tone, canSound, accounting, context, onOpenInsights, onOpenRecord }) {
      const active = view.active;
      return h(
        'div',
        { className: `${PREFIX}-panel`, role: 'dialog', 'aria-label': 'Whale pet interactions and context' },
        h(
          'div',
          { className: `${PREFIX}-head` },
          h('span', { className: `${PREFIX}-dot`, 'data-busy': view.busy ? '1' : undefined }),
          h('span', { className: `${PREFIX}-title` }, '🐋 Whale pet · interactions & context'),
          h(
            'button',
            { className: `${PREFIX}-btn`, type: 'button', onClick: onClose, 'aria-label': 'Collapse' },
            '收起',
          ),
        ),
        h(
          'div',
          { className: `${PREFIX}-scroll` },
          h(
            'div',
            { className: `${PREFIX}-status` },
            h(
              'div',
              { className: `${PREFIX}-statusline` },
              h('span', null, view.busy ? '● 工作中 Working' : view.status === 'error' ? '● 出错 Error' : '○ 空闲 Idle'),
              active.length > 0 ? h('span', { className: `${PREFIX}-tag` }, `${active.length} active`) : null,
            ),
            active.length > 0
              ? active.map((item) =>
                  h(
                    'div',
                    { className: `${PREFIX}-sub`, key: item.sessionId },
                    `${item.label} · ${item.prompt === '' ? 'working…' : item.prompt}${typeof item.startedAt === 'number' ? ` · ${duration(Date.now() - item.startedAt)}` : ''}`,
                  ),
                )
              : h('div', { className: `${PREFIX}-sub` }, `已记录 ${records.length} 次交互 · total ${records.length} interactions`),
            view.disagrees
              ? h(
                  'div',
                  { className: `${PREFIX}-note` },
                  '主机端仍报告忙碌，但浏览器已看不到运行中的会话，此处以浏览器为准。',
                )
              : null,
            view.approvalCount > 0
              ? h(
                  'div',
                  { className: `${PREFIX}-approval` },
                  h(
                    'div',
                    { className: `${PREFIX}-approvalrow` },
                    `⚠ 需要授权 · ${view.approvalCount} pending · Approval needed`,
                  ),
                  view.approvals.map((approval) =>
                    h(
                      'div',
                      { className: `${PREFIX}-approvalrow`, key: `${approval.sessionId}:${approval.id}` },
                      h('b', null, approval.toolName ?? 'tool'),
                      approval.reason !== undefined && approval.reason !== '' ? ` · ${approval.reason}` : '',
                      approval.label !== undefined && approval.label !== ''
                        ? h('span', { className: `${PREFIX}-note` }, ` · ${approval.label}`)
                        : null,
                    ),
                  ),
                )
              : null,
          ),
          h(ContextSection, { context, onOpenInsights }),
          h(AccountSection, accounting),
          h(
            'div',
            { className: `${PREFIX}-list` },
            records.length === 0
              ? h(
                  'div',
                  { className: `${PREFIX}-empty` },
                  '还没有交互记录。',
                  h('br'),
                  '发一条消息给 Harness，这里就会出现一条记录。',
                  h('br'),
                  h('span', { className: `${PREFIX}-note` }, 'No interactions yet — send a prompt and a row appears here.'),
                )
              : records.map((record, index) => h(RecordRow, { key: `${record.sessionId ?? 'x'}-${record.startedAt ?? index}-${index}`, record, index, onOpen: onOpenRecord })),
          ),
        ),
        h(
          'div',
          { className: `${PREFIX}-foot` },
          h(
            'button',
            {
              className: `${PREFIX}-btn`,
              type: 'button',
              onClick: onToggleSound,
              disabled: canSound === false,
              title: canSound === false ? 'This browser exposes no audio output' : undefined,
            },
            soundOn ? '🔔 音效 On' : '🔕 音效 Off',
          ),
          // The tone picker: switching试听 immediately, so the choice is made by
          // ear rather than by name.
          h(
            'select',
            {
              className: `${PREFIX}-sel`,
              value: tone,
              disabled: soundOn === false,
              onChange: (event) => onPickTone(event.target.value),
              title: TONES[tone]?.hint ?? '',
              'aria-label': 'Completion tone',
            },
            Object.entries(TONES).map(([key, value]) => h('option', { key, value: key }, value.label)),
          ),
          h(
            'button',
            {
              className: `${PREFIX}-btn`,
              type: 'button',
              onClick: onPreviewSound,
              disabled: soundOn === false,
              title: '试听完成音效 · Preview the completion cue',
            },
            '▶',
          ),
          h('span', { className: `${PREFIX}-grow` }),
          h('button', { className: `${PREFIX}-btn`, type: 'button', onClick: onClear }, '清空'),
        ),
      );
    }

    /**
     * Decide whether one observed episode should ring the chime.
     *
     * Both observers feed through here so an episode rings at most once. Every
     * high-water mark is PER SESSION: a single global one would let a later
     * episode in one session suppress an earlier one in another (two subagents
     * finishing out of order was enough to silence a cue). The windowed start-time
     * match exists because the client's transition and the Host's record describe
     * the same episode with timestamps taken milliseconds apart.
     *
     * Extracted as a pure function so `tools/client-test.mjs` can test the rule
     * directly instead of through a rendered component.
     *
     * @param memory - `{ sessions: Map, baseline: Map, lastRecordId }`, mutated in place.
     * @param input - one observation: `{ source, sessionId, startedAt, recordId, failed }`.
     * @returns `'silent'`, `'ring'`, or `'mood-only'` (already rang; upgrade the mood).
     */
    function decideCue(memory, input) {
      const { source, sessionId, startedAt, failed = false } = input;
      const key = String(sessionId ?? 'unknown');
      const stamp = typeof startedAt === 'number' ? startedAt : Date.now();
      const seen = memory.sessions.get(key);
      const high = memory.baseline.get(key);

      if (source === 'local') {
        if (high === undefined) {
          // First sight of this session's feed: establish a baseline only, so the
          // pet never chimes for work that finished before the page loaded.
          memory.baseline.set(key, stamp);
          memory.sessions.set(key, [...(seen ?? []), stamp].slice(-8));
          return 'silent';
        }
        if (stamp <= high) return 'silent';
        memory.baseline.set(key, stamp);
        memory.sessions.set(key, [...(seen ?? []), stamp].slice(-8));
        return 'ring';
      }

      if (memory.lastRecordId === undefined) {
        memory.lastRecordId = input.recordId;
        memory.sessions.set(key, [...(seen ?? []), stamp].slice(-8));
        return 'silent';
      }
      if (input.recordId === memory.lastRecordId) return 'silent';
      memory.lastRecordId = input.recordId;
      if (Array.isArray(seen) && seen.some((value) => Math.abs(value - stamp) < 2000)) {
        return failed ? 'mood-only' : 'silent';
      }
      memory.sessions.set(key, [...(seen ?? []), stamp].slice(-8));
      return 'ring';
    }

    /* ------------------------------------------------------------------ *
     * The pet
     * ------------------------------------------------------------------ */

    /**
     * Root-scoped pet. It renders in `shell.overlay`, so it must stay out of the
     * way: a fixed 96px mark in the corner, and the panel only while open.
     */
    function WhalePet(props) {
      // Root standard kit: both hooks arrive from the ui-session root source.
      const useSessions = props.useSessions;
      const useSessionStatus = props.useSessionStatus;

      const [hostState, setHostState] = useState({ ok: false, busy: false, active: [], records: [], feed: [], sessions: [], approvals: [], balance: undefined, now: undefined });
      const [open, setOpen] = useState(false);
      const [mood, setMood] = useState('calm');
      const [soundOn, setSoundOn] = useState(true);
      const [tone, setTone] = useState(() => readTone());
      const [audioReady, setAudioReady] = useState(true);
      const [localRecords, setLocalRecords] = useState(readStored);
      /** Re-render heartbeat for Client projections while the panel is open. */
      const [projectionTick, setProjectionTick] = useState(0);

      const lastBusyRef = useRef(undefined);
      const localOpenRef = useRef(new Map());
      /** Cue memory shared by both completion observers — see `decideCue`. */
      const cueRef = useRef({
        sessions: new Map(),
        baseline: new Map(),
        lastRecordId: undefined,
      });
      const soundRef = useRef(true);
      const moodTimerRef = useRef(undefined);
      /** Whether an approval was already pending on the previous render. */
      const previousApprovalRef = useRef(false);
      /**
       * Live inputs for the polling loop. The loop is mounted once, so it reads
       * the current panel/busy state through this ref instead of re-subscribing
       * (and restarting the HTTP timer) on every state change.
       */
      const pollRef = useRef({ busy: false, open: false });
      const kickPollRef = useRef(() => {});
      pollRef.current.busy = hostState.busy === true;
      pollRef.current.open = open;

      // `useSessions` may be absent in a composition without ui-session; the
      // pet then relies on the Host half alone.
      const listSnapshot =
        typeof useSessions === 'function'
          ? useSessions((value) => value)
          : undefined;
      const statusSnapshot =
        typeof useSessionStatus === 'function'
          ? useSessionStatus((value) => value)
          : undefined;

      /* --- sound preference --- */
      useEffect(() => {
        try {
          const stored = window.localStorage.getItem(`${STORAGE_KEY}.sound`);
          if (stored === 'off') setSoundOn(false);
        } catch {
          /* ignore */
        }
      }, []);
      useEffect(() => {
        soundRef.current = soundOn;
        try {
          window.localStorage.setItem(`${STORAGE_KEY}.sound`, soundOn ? 'on' : 'off');
        } catch {
          /* ignore */
        }
      }, [soundOn]);

      /* --- unlock audio on the first user gesture (autoplay policy) --- */
      useEffect(() => {
        const unlock = () => {
          audio.unlock();
          if (audio.unavailable) setAudioReady(false);
        };
        window.addEventListener('pointerdown', unlock, { passive: true });
        window.addEventListener('keydown', unlock);
        return () => {
          window.removeEventListener('pointerdown', unlock);
          window.removeEventListener('keydown', unlock);
        };
      }, []);

      /* --- poll the Host half, adaptively --- */
      useEffect(() => {
        let stopped = false;
        let inFlight = false;
        let timer;

        /** The cadence for the NEXT request, decided from live state. */
        const delay = () => {
          if (document.hidden) return POLL_MS_HIDDEN;
          return pollRef.current.open || pollRef.current.busy ? POLL_MS_BUSY : POLL_MS_IDLE;
        };

        const tick = async () => {
          if (stopped || inFlight) return;
          inFlight = true;
          try {
            const controller = new AbortController();
            const abort = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            const response = await fetch(ENDPOINT, { signal: controller.signal, headers: { accept: 'application/json' } });
            window.clearTimeout(abort);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            if (stopped) return;
            setHostState({
              ok: body?.ok === true,
              busy: body?.busy === true,
              active: Array.isArray(body?.active) ? body.active : [],
              records: Array.isArray(body?.records) ? body.records : [],
              feed: Array.isArray(body?.feed) ? body.feed : [],
              sessions: Array.isArray(body?.sessions) ? body.sessions : [],
              approvals: Array.isArray(body?.approvals) ? body.approvals : [],
              balance: body?.balance !== null && typeof body?.balance === 'object' ? body.balance : undefined,
              now: typeof body?.now === 'number' ? body.now : undefined,
            });
          } catch {
            // Keep the last known view but mark the Host half unreachable, so the
            // ledger falls back to the client-derived one instead of showing a
            // frozen host snapshot.
            if (!stopped) setHostState((current) => ({ ...current, ok: false, active: [], approvals: [] }));
          } finally {
            inFlight = false;
            window.clearTimeout(timer);
            if (!stopped) timer = window.setTimeout(tick, delay());
          }
        };

        /** Request an immediate refresh without starting a second loop. */
        const kick = () => {
          if (stopped || document.hidden || inFlight) return;
          window.clearTimeout(timer);
          tick();
        };
        kickPollRef.current = kick;

        tick();
        document.addEventListener('visibilitychange', kick);
        window.addEventListener('focus', kick);
        return () => {
          stopped = true;
          kickPollRef.current = () => {};
          window.clearTimeout(timer);
          document.removeEventListener('visibilitychange', kick);
          window.removeEventListener('focus', kick);
        };
      }, []);

      // Opening the panel (or work starting) should not wait out an idle tick.
      useEffect(() => {
        if (open) kickPollRef.current();
      }, [open]);
      useEffect(() => {
        if (hostState.busy) kickPollRef.current();
      }, [hostState.busy]);

      // While the panel is open, re-read Client projections on their own cadence:
      // the Host poll is deliberately slower when idle, and dsh-context's
      // timeline updates arrive through the projection channel, not that route.
      useEffect(() => {
        if (!open) return undefined;
        const timer = window.setInterval(() => setProjectionTick((value) => value + 1), PROJECTION_TICK_MS);
        return () => window.clearInterval(timer);
      }, [open]);

      // Escape closes the panel, matching the dialog's visual affordance.
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [open]);

      /* --- client-derived ledger: fold running-state transitions --- */
      const runningIds = useMemo(() => {
        const ids = [];
        if (statusSnapshot instanceof Map) {
          for (const [id, status] of statusSnapshot) {
            if (status?.running === true) ids.push(id);
          }
        } else if (listSnapshot?.byId !== undefined) {
          for (const row of Object.values(listSnapshot.byId)) {
            const id = row?.id ?? row?.sessionId;
            if (row?.running === true && typeof id === 'string') ids.push(id);
          }
        }
        return ids;
      }, [statusSnapshot, listSnapshot]);

      // The fold below must run only when the *set* of running sessions changes,
      // not on every render. `runningIds` is a fresh array each time the selector
      // snapshot is read, so a stable string key is the dependency that matters.
      const runningKey = useMemo(() => [...runningIds].sort().join('\u0000'), [runningIds]);

      useEffect(() => {
        const ids = runningKey === '' ? [] : runningKey.split('\u0000');
        const pending = localOpenRef.current;
        const now = Date.now();
        const seen = new Set(ids);
        for (const id of ids) {
          if (pending.has(id)) continue;
          const row = listSnapshot?.byId?.[id];
          pending.set(id, {
            sessionId: id,
            label: row?.title ?? row?.displayTitle ?? shortId(id),
            startedAt: now,
            prompt: row?.title ?? row?.displayTitle ?? '',
          });
        }
        for (const [id, episode] of [...pending]) {
          if (seen.has(id)) continue;
          pending.delete(id);
          const endedAt = Date.now();
          const finished = {
            sessionId: id,
            label: episode.label,
            startedAt: episode.startedAt,
            endedAt,
            durationMs: Math.max(0, endedAt - episode.startedAt),
            prompt: episode.prompt,
            reply: '',
            tools: 0,
            turns: 0,
            steps: 0,
          };
          setLocalRecords((current) => {
            const next = [finished, ...current].slice(0, LOCAL_RECORD_LIMIT);
            writeStored(next);
            return next;
          });
        }
      }, [runningKey, listSnapshot]);

      /**
       * Whether the Client's own session view is loaded enough to be trusted.
       *
       * `useSessionStatus` resolves to a Map once the ui-session root source is
       * live; before that it is undefined and the Client knows nothing, so the
       * Host has to be believed. That distinction is what lets the view be
       * corrected without ever going blind.
       */
      const clientKnows = statusSnapshot instanceof Map;

      /* --- effective view --- *
       * `busy` is the Client's live view whenever the Client has one, because
       * that view comes straight from session status and cannot go stale. The
       * Host's snapshot is believed only when the Client has nothing to say.
       *
       * Neither a plain union nor a plain preference works here, and both were
       * tried: preferring the Host hides work the Client can plainly see, and a
       * union lets one stuck Host claim freeze the pet on "working" forever after
       * the turn ended. Correcting the Host against the Client is the only shape
       * that is right in both directions.
       */
      const view = useMemo(() => {
        const running = runningKey === '' ? [] : runningKey.split('\u0000');
        const clientBusy = running.length > 0;
        const resolved = resolveBusy({ clientKnows, clientBusy, hostBusy: hostState.busy });
        const busy = resolved.busy;
        const lastError = hostState.records.find((record) => typeof record.error === 'string' && record.error !== '');
        const approvals = Array.isArray(hostState.approvals) ? hostState.approvals : [];
        return {
          busy,
          // The Host still claims work the Client cannot see: the two disagree,
          // and the Client's answer is the one shown.
          disagrees: resolved.disagrees,
          status: busy ? 'running' : lastError !== undefined && Date.now() - (lastError.endedAt ?? 0) < 8000 ? 'error' : 'idle',
          approvals,
          approvalCount: approvals.length,
          // The Host's richer `active` detail is used only while `busy` is true,
          // so a stale Host entry cannot outlive the status above it.
          active: busy && hostState.active.length > 0
            ? hostState.active
            : running.map((id) => {
                const row = listSnapshot?.byId?.[id];
                return {
                  sessionId: id,
                  label: row?.title ?? row?.displayTitle ?? shortId(id),
                  startedAt: undefined,
                  prompt: row?.title ?? row?.displayTitle ?? '',
                };
              }),
        };
      }, [hostState, runningKey, listSnapshot, clientKnows]);

      const records = useMemo(() => selectRecords(hostState.ok, hostState.records, localRecords), [
        hostState.ok,
        hostState.records,
        localRecords,
      ]);

      /** Stable identity of the pending-permission set, used to ring only on change. */
      const approvalKey = useMemo(
        () => view.approvals.map((approval) => `${approval.sessionId ?? ''}:${approval.id ?? ''}`).sort().join('\u0000'),
        [view.approvals],
      );

      /* --- cost accounting: one rate table, one price rule --- */
      const [rateModel, setRateModel] = useState(() => readRates().model);
      const [rateCurrency, setRateCurrency] = useState(() => readRates().currency);
      const rateChoice = useMemo(() => readRates(), [rateCurrency]);
      const rateTable = rateChoice.table;
      const rateModels = rateChoice.models;
      const symbol = rateChoice.symbol;
      const peak = useMemo(() => isPeak(new Date()), [hostState.now]);
      const rate = (rateModels[rateModel] ?? Object.values(rateModels)[0])[peak ? 'peak' : 'offPeak'];
      // `ctx` is a stable service locator, not render state: caching it in a ref
      // keeps it out of the dependency arrays below.
      const servicesRef = useRef(undefined);
      if (servicesRef.current === undefined && typeof props.ctx?.get === 'function') {
        servicesRef.current = { get: (name) => props.ctx.get(name) };
      }

      /** Result of the retried Client-side projection read, once it lands. */
      const [clientTokensFallback, setClientTokensFallback] = useState(undefined);
      /**
       * Retry the Client-side `tokenUsage` read.
       *
       * `sessions.refreshProjections` is asynchronous: the projection only fills
       * in after it settles, so one synchronous read is guaranteed to see
       * nothing on a cold panel. This polls a handful of times and stops as soon
       * as a value arrives, so the accounting block populates without the user
       * having to reopen it.
       */
      useEffect(() => {
        if (!open) return undefined;
        const sessions = servicesRef.current?.get?.('sessions');
        if (sessions === undefined) return undefined;
        const rows = hostState.sessions ?? [];
        if (rows.some((row) => row.totalTokens > 0)) return undefined;

        const activeRow = Object.values(listSnapshot?.byId ?? {}).find((row) => (row?.retainedBy?.mainView ?? 0) > 0);
        const active = activeRow?.id ?? activeRow?.sessionId;
        const targetId = active ?? rows[0]?.sessionId ?? runningKey.split('\u0000').filter(Boolean)[0];
        if (targetId === undefined) return undefined;

        let stopped = false;
        let timer;
        let attempt = 0;
        const probe = () => {
          if (stopped) return;
          const tokens = readClientTokens(sessions, targetId);
          if (tokens !== undefined) {
            setClientTokensFallback({ sessionId: targetId, tokens });
            return;
          }
          refreshClientTokens(sessions, targetId);
          attempt += 1;
          if (attempt < 6) timer = window.setTimeout(probe, 600);
        };
        probe();
        return () => {
          stopped = true;
          window.clearTimeout(timer);
        };
      }, [open, hostState.sessions, listSnapshot, runningKey]);

      /** The retried read as a panel row, if it has landed. */
      const clientFallbackSession = useMemo(() => {
        if (clientTokensFallback === undefined) return undefined;
        const { sessionId, tokens } = clientTokensFallback;
        const row = (hostState.sessions ?? []).find((entry) => entry.sessionId === sessionId);
        return {
          ...(row ?? { sessionId, label: shortId(sessionId) }),
          tokens,
          totalTokens: tokensTotal(tokens),
          source: 'client',
        };
      }, [clientTokensFallback, hostState.sessions]);
      /**
       * The session currently in the center column: the main-view retain first,
       * then any running session for a page with no conversation selected.
       */
      const activeSessionId = useMemo(() => {
        const mainRow = Object.values(listSnapshot?.byId ?? {}).find((row) => (row?.retainedBy?.mainView ?? 0) > 0);
        const main = mainRow?.id ?? mainRow?.sessionId;
        if (typeof main === 'string' && main !== '') return main;
        return runningKey.split('\u0000').filter(Boolean)[0];
      }, [listSnapshot, runningKey]);

      /**
       * The session whose accounting is shown: exactly the session above.
       *
       * If the current session is not in the Host snapshot yet, use the browser's
       * own `tokenUsage` projection and a synthetic row — NOT another session's
       * bill. The old fallback to "newest session with spend" is what made a
       * subagent or another conversation appear under a "this session" label.
       */
      const accountingSession = useMemo(() => {
        const rows = hostState.sessions ?? [];
        if (activeSessionId !== undefined) {
          const activeRow = rows.find((row) => row.sessionId === activeSessionId);
          if (activeRow !== undefined) {
            // The Host folds only events seen since this plugin process loaded;
            // a long-lived session therefore looks cheaper than its durable log.
            // The browser `tokenUsage` projection is the full session, so prefer
            // it for the money/token figures and keep the Host row's request count.
            const durable = readClientTokens(servicesRef.current?.get?.('sessions'), activeSessionId);
            if (durable !== undefined) {
              return {
                ...activeRow,
                tokens: { ...durable, requests: activeRow.tokens?.requests ?? durable.requests },
                totalTokens: tokensTotal(durable),
                source: 'merged',
              };
            }
            return activeRow;
          }
          if (clientFallbackSession?.sessionId === activeSessionId) return clientFallbackSession;

          const listRow = listSnapshot?.byId?.[activeSessionId];
          const clientTokens = readClientTokens(servicesRef.current?.get?.('sessions'), activeSessionId);
          return {
            sessionId: activeSessionId,
            label: listRow?.title ?? listRow?.displayTitle ?? shortId(activeSessionId),
            elapsedMs: undefined,
            totalTokens: clientTokens === undefined ? 0 : tokensTotal(clientTokens),
            tokens: clientTokens ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0 },
            source: 'client',
          };
        }

        // No current session selected: fall back to the newest session with spend,
        // then to the browser-side projection, then to a zeroed row.
        const withSpend = rows.find((row) => row.totalTokens > 0);
        if (withSpend !== undefined) return withSpend;
        if (clientFallbackSession !== undefined) return clientFallbackSession;
        const row = rows[0];
        return {
          ...(row ?? {}),
          sessionId: row?.sessionId ?? '',
          label: row?.label ?? '',
          elapsedMs: row?.elapsedMs,
          totalTokens: row?.totalTokens ?? 0,
          tokens: row?.tokens ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0 },
          source: row?.source ?? 'client',
        };
      }, [hostState.sessions, listSnapshot, activeSessionId, clientFallbackSession]);

      /**
       * The ledger rows belonging to the accounting session.
       *
       * The pet's record list is global (all sessions, capped at 80), but the
       * accounting card is titled "this session". Without this filter the count
       * and per-interaction list mix in subagents and other conversations.
       */
      const accountingRecords = useMemo(() => {
        const sessionId = accountingSession?.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '') return [];
        return records.filter((record) => record.sessionId === sessionId);
      }, [records, accountingSession]);

      /**
       * The session whose context the panel tracks.
       *
       * Use the same target as the accounting card so the two can never show
       * different conversations. `activeSessionId` already prefers the main-view
       * retain, then a running session.
       */
      const contextTargetId = useMemo(
        () => activeSessionId ?? accountingSession?.sessionId,
        [activeSessionId, accountingSession],
      );

      /**
       * Live context reading. Re-read when the Host poll lands, the open panel
       * ticks, or the session changes; all sources are optional projections, so
       * this stays undefined rather than throwing when none is available.
       */
      const context = useMemo(
        () => readContext(servicesRef.current?.get?.('sessions'), contextTargetId),
        [contextTargetId, listSnapshot, statusSnapshot, hostState, projectionTick, open],
      );

      /** The session row the card renders, with the fullest peak/off split available. */
      const displaySession = useMemo(() => {
        if (accountingSession === undefined) return accountingSession;
        const hostPeriods = accountingSession.periods;
        const recordPeriods = periodsFromRecords(accountingRecords);
        const durableTotal = accountingSession.totalTokens ?? 0;
        const hostTotal = hostPeriods === undefined ? 0 : tokensTotal(periodsTokens(hostPeriods));
        const recordTotal = recordPeriods === undefined ? 0 : tokensTotal(periodsTokens(recordPeriods));
        if (hostTotal > 0 && hostTotal >= durableTotal) {
          return { ...accountingSession, periods: hostPeriods, periodsSource: 'host' };
        }
        if (recordTotal > 0 && recordTotal >= durableTotal) {
          return { ...accountingSession, periods: recordPeriods, periodsSource: 'records' };
        }
        const fromContext = periodsFromCostUsage(context?.cost);
        if (fromContext !== undefined) {
          return { ...accountingSession, periods: fromContext, periodsSource: 'context' };
        }
        if (hostTotal > 0) {
          return { ...accountingSession, periods: hostPeriods, periodsSource: 'host' };
        }
        if (recordTotal > 0) {
          return { ...accountingSession, periods: recordPeriods, periodsSource: 'records' };
        }
        return accountingSession;
      }, [accountingSession, accountingRecords, context]);

      // Load the active session's projections once when the session changes, not
      // only when the panel opens: the context card should populate from a cold start
      // too. One delayed tick picks up the projection that arrives after the
      // asynchronous refresh.
      useEffect(() => {
        const sessions = servicesRef.current?.get?.('sessions');
        if (sessions === undefined || contextTargetId === undefined) return undefined;
        refreshClientTokens(sessions, contextTargetId);
        const timer = window.setTimeout(() => setProjectionTick((value) => value + 1), 800);
        return () => window.clearTimeout(timer);
      }, [contextTargetId]);

      // Opening the panel is the moment a cold projection is worth loading.
      // `refreshProjections` is asynchronous, so a second attempt covers the
      // first read racing the projection's arrival.
      useEffect(() => {
        if (!open || contextTargetId === undefined) return undefined;
        const sessions = servicesRef.current?.get?.('sessions');
        if (sessions === undefined) return undefined;
        let stopped = false;
        let timer;
        let attempt = 0;
        const load = () => {
          if (stopped) return;
          refreshClientTokens(sessions, contextTargetId);
          attempt += 1;
          if (attempt < 2) timer = window.setTimeout(load, 900);
        };
        load();
        return () => {
          stopped = true;
          window.clearTimeout(timer);
        };
      }, [open, contextTargetId]);

      /**
       * Open the conversation behind one interaction record.
       *
       * `uiWorkspace.openSession` is the public Client action that switches the
       * center column to a session; `layout.selectPanel('conversation')` makes
       * sure the conversation panel is the visible one if another main panel
       * (Plugins, Context Insights, …) was selected. A session that has since
       * been archived or disposed may refuse the jump, so a failure leaves the
       * panel open rather than closing it onto nothing.
       */
      const openRecord = useCallback((record) => {
        const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
        if (sessionId === '') return;
        try {
          const services = servicesRef.current;
          const workspace = services?.get?.('uiWorkspace');
          if (typeof workspace?.openSession !== 'function') return;
          workspace.openSession(sessionId);
          const layout = services?.get?.('layout');
          if (typeof layout?.selectPanel === 'function') layout.selectPanel('conversation');
          setOpen(false);
        } catch {
          /* archived/disposed session: keep the panel so its row is not lost */
        }
      }, []);

      /**
       * Jump to dsh-context's Context Insights page.
       *
       * `layout.selectPanel` is the public Client navigation action, and
       * `dsh-context` is the key that plugin registers on the `main` slot. A
       * deployment without dsh-context simply does nothing: the button is only
       * rendered when its `contextTimeline` projection proved it is present.
       */
      const openContextInsights = useCallback(() => {
        try {
          const layout = servicesRef.current?.get?.('layout');
          if (typeof layout?.selectPanel === 'function') {
            layout.selectPanel('dsh-context');
            setOpen(false);
          }
        } catch {
          /* dsh-context is not installed in this profile */
        }
      }, []);

      const chooseModel = useCallback((next) => {
        setRateModel(next);
        try {
          window.localStorage.setItem(RATE_MODEL_KEY, next);
        } catch {
          /* the choice simply will not persist */
        }
      }, []);
      const chooseCurrency = useCallback((next) => {
        setRateCurrency(next);
        try {
          window.localStorage.setItem(RATE_CURRENCY_KEY, next);
        } catch {
          /* the choice simply will not persist */
        }
      }, []);

      /**
       * Completion and start cues.
       *
       * The CLIENT's own running-state transition is the primary trigger, not the
       * Host half's record list. The chime must not depend on the Host being
       * healthy: `useSessionStatus` already observes every session, so a finished
       * episode is visible here even when the Host ledger is empty or stale.
       *
       * `decideCue`'s memory remembers which episodes have chimed, keyed by
       * session and start time, so a Host record arriving moments later for the
       * SAME episode enriches the row without ringing twice. The Host record
       * still upgrades the cue to the error tone, which the client cannot know.
       */
      useEffect(() => {
        const busy = view.busy;
        const previousBusy = lastBusyRef.current;
        lastBusyRef.current = busy;
        if (previousBusy === false && busy && soundRef.current) audio.start();
      }, [view.busy]);

      /**
       * Permission alarm — one ring per pending episode.
       *
       * A pending approval is a blocking state, so it gets a single urgent cue
       * the first time the set becomes non-empty. It deliberately does NOT repeat
       * while the request stays unresolved, does not re-ring when the page becomes
       * visible, and does not ring again for a second request arriving alongside
       * the first. Once the set empties, a later approval rings again.
       */
      useEffect(() => {
        const active = approvalKey !== '';
        const wasActive = previousApprovalRef.current;
        previousApprovalRef.current = active;
        if (!active || wasActive || !soundOn) return;
        audio.unlock();
        audio.urgent();
      }, [approvalKey, soundOn]);

      /** Play one cue outcome, or only fix the mood when it already rang. */
      const applyCue = useCallback((decision, failed) => {
        if (decision === 'silent') return;
        setMood(failed ? 'error' : 'done');
        window.clearTimeout(moodTimerRef.current);
        moodTimerRef.current = window.setTimeout(() => setMood('calm'), 2600);
        if (decision !== 'ring' || !soundRef.current) return;
        if (failed) audio.failed();
        else audio.done();
      }, []);

      // Primary: an episode the client itself saw end. This is what makes the
      // chime work even when the Host half is stale, empty, or unreachable.
      useEffect(() => {
        const newest = localRecords[0];
        if (newest === undefined) return;
        const decision = decideCue(cueRef.current, {
          source: 'local',
          sessionId: newest.sessionId,
          startedAt: newest.startedAt,
          failed: false,
        });
        applyCue(decision, false);
      }, [localRecords, applyCue]);

      // Secondary: the Host's record, which carries prompt text and any failure
      // the client cannot see. It rings only if the client did not already.
      useEffect(() => {
        const newest = hostState.records[0];
        if (newest === undefined) return;
        const failed = typeof newest.error === 'string' && newest.error !== '';
        const decision = decideCue(cueRef.current, {
          source: 'host',
          sessionId: newest.sessionId,
          startedAt: newest.startedAt,
          recordId: newest.id,
          failed,
        });
        applyCue(decision, failed);
      }, [hostState.records, applyCue]);

      useEffect(() => () => window.clearTimeout(moodTimerRef.current), []);

      const clearAll = useCallback(() => {
        setLocalRecords([]);
        writeStored([]);
        localOpenRef.current.clear();
        setHostState((current) => ({ ...current, records: [] }));
      }, []);

      const toggleSound = useCallback(() => {
        setSoundOn((value) => {
          if (!value) audio.unlock();
          return !value;
        });
      }, []);

      /**
       * Preview the completion cue.
       *
       * A user gesture is exactly what the autoplay policy wants, so this both
       * proves the audio path works and removes any doubt about whether the cue
       * is audible — no need to wait for a turn to finish. Switching tone also
       * previews, so the choice is made by ear.
       */
      const previewSound = useCallback(() => {
        audio.unlock();
        audio.done();
      }, []);

      /** Switch the completion tone and play it, so the pick is audible at once. */
      const pickTone = useCallback((next) => {
        setTone(next);
        audio.setTone(next);
        audio.unlock();
        audio.done();
      }, []);

      const onClickPet = useCallback(() => {
        audio.unlock();
        setOpen((value) => !value);
      }, []);

      const busy = view.busy;
      const approvalCount = view.approvalCount;
      const approvalTitle = approvalCount > 0 ? `需要授权 ${approvalCount} · Approval needed` : undefined;
      /** Context text reused by the pet's tooltip and accessible label. */
      const contextPct = context?.ratio === undefined ? undefined : `${(context.ratio * 100).toFixed(1)}%`;
      const contextTitle = contextPct === undefined ? undefined : `上下文 ${contextPct} · Context ${contextPct}`;

      return h(
        React.Fragment,
        null,
        h(Stylesheet),
        h(
          'div',
          { className: `${PREFIX}-root` },
          open
            ? h(Panel, {
                view,
                records,
                onClear: clearAll,
                onClose: () => setOpen(false),
                soundOn,
                onToggleSound: toggleSound,
                onPreviewSound: previewSound,
                onPickTone: pickTone,
                tone,
                canSound: audioReady,
                context,
                onOpenInsights: openContextInsights,
                onOpenRecord: openRecord,
                accounting: {
                  session: displaySession,
                  records: accountingRecords,
                  todayRecords: records,
                  requests: context?.steps || accountingSession?.tokens?.requests || 0,
                  rate,
                  model: rateModel,
                  models: rateModels,
                  table: rateTable,
                  currency: rateCurrency,
                  symbol,
                  peak,
                  balance: hostState.balance,
                  onModel: chooseModel,
                  onCurrency: chooseCurrency,
                },
              })
            : null,
          h(
            'button',
            {
              className: `${PREFIX}-lyr`,
              type: 'button',
              onClick: onClickPet,
              'data-busy': busy ? '1' : '0',
              'data-mood': mood,
              'data-approval': approvalCount > 0 ? '1' : '0',
              'aria-expanded': open,
              'aria-label': `${approvalCount > 0 ? `Approval needed for ${approvalCount} request${approvalCount === 1 ? '' : 's'}.` : ''}${busy ? 'Whale pet: Harness is working.' : mood === 'done' ? 'Whale pet: work just finished.' : 'Whale pet: idle.'}${contextPct === undefined ? '' : ` Context ${contextPct} full.`} Open the interaction log.`,
              title: [approvalTitle, busy ? 'Harness 工作中 · Working' : mood === 'done' ? 'Harness 刚完成 · Finished' : 'Harness 空闲 · Idle', contextTitle].filter(Boolean).join(' · '),
            },
            h(Whale, { busy, mood }),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Plugin contract
     * ------------------------------------------------------------------ */

    return {
      // `slots` is a hard dependency. The root hooks arrive through the slot kit,
      // so a missing ui-session degrades instead of throwing.
      inject: ['slots'],
      apply(ctx) {
        /**
         * Bind this plugin's Client context to the component explicitly.
         *
         * The `shell.overlay` standard kit supplies hooks, not a `ctx` prop, yet
         * the panel needs optional Client services (`sessions`, `layout`) to read
         * projections and open dsh-context. Handing the component a wrapper that
         * injects the real context keeps that lookup working in every kit shape
         * and avoids reaching for a global.
         */
        const WhalePetWithContext = (props) => h(WhalePet, { ...props, ctx });
        ctx.effect(
          () =>
            ctx.slots.inject('shell.overlay', () =>
              ctx.slots.register(
                {
                  name: 'shell.overlay',
                  id: 'pet-whale',
                  order: 40,
                  label: 'Whale pet',
                },
                WhalePetWithContext,
              ),
            ),
          'pet-whale: shell.overlay registration',
        );
      },
    };
  },
});
