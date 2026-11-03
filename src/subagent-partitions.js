// src/subagent-partitions.js — Subagent Concurrency Partitions & Isolation (#575).
// Pure module: zero runtime dependencies, strictly < 600 lines.

export const DEFAULT_SUBAGENT_MAX_CONCURRENCY_PER_KEY = 2;

/**
 * Extracts subagent or background task context from request options and metadata.
 * @param {object} options
 * @returns {{ isSubagent: boolean, subagentId?: string, parentSessionId?: string }}
 */
export function extractSubagentContext(options) {
  if (!options || typeof options !== 'object') return { isSubagent: false };
  const meta = options.metadata || options.meta || {};
  const parentSessionId = typeof meta.parentSessionId === 'string' && meta.parentSessionId.trim() ? meta.parentSessionId.trim() : undefined;

  let isSubagent = false;
  let subagentId = undefined;

  if (options.isSubagent === true || meta.isSubagent === true) {
    isSubagent = true;
    subagentId = options.subagentId || meta.subagentId;
  } else if (typeof options.subagentId === 'string' && options.subagentId.trim()) {
    isSubagent = true;
    subagentId = options.subagentId.trim();
  } else if (typeof meta.subagentId === 'string' && meta.subagentId.trim()) {
    isSubagent = true;
    subagentId = meta.subagentId.trim();
  } else if (typeof options.subagent === 'string' && options.subagent.trim()) {
    isSubagent = true;
    subagentId = options.subagent.trim();
  } else if (options.subagent === true) {
    isSubagent = true;
  } else if (parentSessionId) {
    isSubagent = true;
    subagentId = meta.childSessionId;
  } else {
    // Check sessionId prefixes
    const sid = String(options.sessionId || options.session || options.chatId || options.conversationId || '').trim();
    if (
      sid.startsWith('subagent:') ||
      sid.startsWith('subagent-') ||
      sid.startsWith('subtask:') ||
      sid.startsWith('subtask-') ||
      sid.startsWith('agent:sub:')
    ) {
      isSubagent = true;
      subagentId = sid;
    } else {
      // Check tags
      const tags = Array.isArray(options.tags) ? options.tags : (Array.isArray(meta.tags) ? meta.tags : []);
      if (tags.some(t => typeof t === 'string' && (t === 'subagent' || t === 'subtask' || t === 'background'))) {
        isSubagent = true;
        subagentId = options.subagentId || meta.subagentId;
      }
    }
  }

  if (isSubagent) {
    const res = { isSubagent: true };
    if (subagentId) res.subagentId = subagentId;
    if (parentSessionId) res.parentSessionId = parentSessionId;
    return res;
  }

  return { isSubagent: false };
}

/**
 * Partitions or reorders candidate keys according to subagent isolation rules.
 * @param {string[]} attemptList
 * @param {object} pool
 * @param {object} [options]
 * @returns {string[]}
 */
export function partitionPoolKeys(attemptList, pool, options = {}) {
  if (!Array.isArray(attemptList) || attemptList.length <= 1 || !pool) {
    return (attemptList ?? []).slice();
  }

  const enabled = options.enabled ?? pool.subagentPartitionsEnabled ?? true;
  if (!enabled) return attemptList.slice();

  const subCtx = options.subagentContext ?? extractSubagentContext(options.reqOptions);
  const isSubagent = Boolean(subCtx.isSubagent);
  const reservedCount = pool.subagentReservedKeysCount ?? 0;
  const strategy = pool.subagentPartitionStrategy ?? 'shared-burst';
  const labels = pool.labels || {};

  const explicitSubagentRefs = new Set();
  const explicitPrimaryRefs = new Set();

  for (const [ref, label] of Object.entries(labels)) {
    const lbl = String(label).toLowerCase();
    if (lbl === 'subagent' || lbl === 'subtask' || lbl === 'worker') explicitSubagentRefs.add(ref);
    if (lbl === 'primary' || lbl === 'main' || lbl === 'user') explicitPrimaryRefs.add(ref);
  }

  // If reservedCount > 0, reserve the last reservedCount keys of pool.refs if not already labelled primary
  if (reservedCount > 0 && pool.refs && pool.refs.length > reservedCount) {
    const reservedSlice = pool.refs.slice(pool.refs.length - reservedCount);
    for (const r of reservedSlice) {
      if (!explicitPrimaryRefs.has(r)) explicitSubagentRefs.add(r);
    }
  }

  const hasPartitioning = explicitSubagentRefs.size > 0;
  let list = attemptList.slice();

  if (isSubagent) {
    // SUBAGENT REQUEST
    if (hasPartitioning) {
      const dedicated = list.filter(r => explicitSubagentRefs.has(r));
      const shared = list.filter(r => !explicitSubagentRefs.has(r));

      if (strategy === 'isolated') {
        if (dedicated.length > 0) list = dedicated;
      } else {
        list = dedicated.concat(shared);
      }
    }
  } else {
    // PRIMARY / USER REQUEST
    if (hasPartitioning) {
      const primary = list.filter(r => !explicitSubagentRefs.has(r));
      const subOnly = list.filter(r => explicitSubagentRefs.has(r));

      if (primary.length > 0) {
        list = strategy === 'isolated' ? primary : primary.concat(subOnly);
      }
    }
  }

  // Apply subagent per-key concurrency cap
  const tracker = options.concurrencyTracker;
  const maxSubConcurrency = pool.subagentMaxConcurrencyPerKey ?? DEFAULT_SUBAGENT_MAX_CONCURRENCY_PER_KEY;
  if (isSubagent && tracker && typeof tracker.getActive === 'function' && maxSubConcurrency > 0) {
    const now = options.now ?? Date.now();
    const withinCap = [];
    const saturated = [];
    for (const r of list) {
      const active = tracker.getActive(r, now) ?? 0;
      if (active >= maxSubConcurrency) {
        saturated.push(r);
      } else {
        withinCap.push(r);
      }
    }
    if (withinCap.length > 0 && saturated.length > 0) {
      list = withinCap.concat(saturated);
    }
  }

  if (options.trace && typeof options.trace.addStep === 'function' && list[0] !== attemptList[0]) {
    options.trace.addStep(
      list[0],
      'PRIORITIZED',
      'SUBAGENT_PARTITION',
      isSubagent ? 'Subagent partition key allocated' : 'Primary chat partition prioritized'
    );
  }

  return list;
}
