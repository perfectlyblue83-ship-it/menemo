'use strict';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const FC_CONSTANTS = {
  EASY_INTERVAL_DAYS:        4,
  DEFAULT_LEARNING_STEPS:    [1, 10],
  DEFAULT_RELEARNING_STEPS:  [10],
  FALLBACK_DECK:             { name: 'Uncategorized', color: '#7B6EF6' },
  TIMER_INTERVAL_MS:         1000,
  DROPDOWN_DEBOUNCE_MS:      150,
};

// ─── LOCAL UTILITIES ──────────────────────────────────────────────────────────

function ensureCardState() {
  if (!state.sm2)  state.sm2  = {};
  if (!state.fsrs) state.fsrs = {};
}

function fcParseStartDateToMs(startDate) {
  if (!startDate || typeof startDate !== 'string') return null;
  const parsed = typeof parseD === 'function' ? parseD(startDate) : new Date(startDate);
  const ms     = parsed instanceof Date ? parsed.getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Reads `card.nextReviewAt` and returns it as a finite ms timestamp,
 * or null if missing / unparseable.
 */
function fcGetNextReviewAtMs(card) {
  const raw = card?.nextReviewAt;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const asNum = Number(raw);
    if (Number.isFinite(asNum)) return asNum;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Returns true when the card's nextReviewAt timestamp has passed (or is absent).
 */
function fcIsDueByTimestampNow(card, now = Date.now()) {
  const nextMs = fcGetNextReviewAtMs(card);
  if (nextMs === null) return true;
  return nextMs <= now;
}

/**
 * Delegates to getRetention() from fsrs6.js which uses the correct
 * FSRS-6 forgetting curve: R(t,S) = (1 + decayFactor*t/S)^(-decay).
 * Falls back gracefully if fsrs6 is not loaded yet.
 */
function fcGetReviewRetentionPercent(card) {
  try {
    if (typeof getRetention === 'function') return getRetention(card);

    if (typeof window._fsrs?.forgettingCurve === 'function' &&
        card?.state?.stability && card?.lastReviewedAt) {
      const elapsedDays = Math.max(0, (Date.now() - Number(card.lastReviewedAt)) / 86_400_000);
      return Math.round(window._fsrs.forgettingCurve(elapsedDays, card.state.stability) * 100);
    }

    return 100;
  } catch { return 100; }
}

function fcGetLearningStepMinutes(card) {
  const isRelearning = card?.pile === 'relearning';
  const steps        = isRelearning
    ? (window.SCHEDULER_CONFIG?.RELEARNING_STEPS || FC_CONSTANTS.DEFAULT_RELEARNING_STEPS)
    : (window.SCHEDULER_CONFIG?.LEARNING_STEPS   || FC_CONSTANTS.DEFAULT_LEARNING_STEPS);
  const stepIndex    = Number.isInteger(card?.stepIndex) ? card.stepIndex : 0;
  const safeIdx      = Math.max(0, Math.min(stepIndex, steps.length - 1));
  return Number(steps[safeIdx]) || 0;
}

function fcTag(topic, meta = {}) {
  return { ...topic, __queueMeta: { ...meta } };
}

// ─── FIX #7: Read-only card accessor — no side effects ───────────────────────
/**
 * Returns the card from state.sm2 without creating it if absent.
 * Use this in queue building and rendering so we don't dirty state on every
 * render. Only call ensureCard() when you intend to actually study the card.
 */
function getCard(tid) {
  return state.sm2?.[tid] || null;
}

// ─── FIX #8: ensureCard saves isPastFixed cards like any other card ───────────
/**
 * Returns the card for tid, creating and persisting it if absent.
 * Previously, isPastFixed cards were returned as a throwaway object —
 * any ratings on them were silently lost on next render.
 */
function ensureCard(tid) {
  ensureCardState();
  if (!state.sm2[tid]) {
    state.sm2[tid] = fsrsInit(tid);
  }
  return state.sm2[tid];
}

// ─── DECK FILTER HELPER ───────────────────────────────────────────────────────

/**
 * Builds the full set of deck IDs that fall within the filter deck
 * (including the filter deck itself).
 *
 * FIX #2D: getSubDeckIds result is validated — if it returns empty or throws,
 * we always fall through to the manual recursive walk so sub-deck topics
 * (including migrated General inbox cards) are never silently excluded.
 *
 * Returns null when deckFilter === 'all' (no filtering needed).
 */
function _buildFilterDeckIdSet(deckFilter) {
  if (deckFilter === 'all') return null;

  const result = new Set([deckFilter]);

  if (typeof getSubDeckIds === 'function') {
    try {
      const ids = getSubDeckIds(deckFilter);
      if (Array.isArray(ids) && ids.length > 0) {
        ids.forEach(id => result.add(id));
        return result;
      }
      // getSubDeckIds returned empty — fall through to manual walk
    } catch (e) {
      console.warn('[FC] getSubDeckIds threw, falling back to manual walk:', e);
    }
  }

  // Manual recursive walk — guaranteed fallback
  const collect = (pid) => {
    (state.decks || [])
      .filter(d => d.parentId === pid)
      .forEach(child => { result.add(child.id); collect(child.id); });
  };
  collect(deckFilter);
  return result;
}

// ─── QUEUE BUILDER ────────────────────────────────────────────────────────────

/**
 * Builds a static priority queue for a session.
 *
 * Order: relearning → review (lowest retention first) → learning → new (limited).
 *
 * FIX #2A — New cards checked BEFORE doneIds.
 * FIX #2B — dailyNewLimit = 0 no longer silently hides new cards.
 * FIX #2C — dailyNewLimit accounts for new cards already studied today.
 * FIX #7  — uses getCard() (read-only) instead of ensureCard() to avoid
 *            dirtying state.sm2 and triggering unnecessary saves on every render.
 */
function buildFlashcardPriorityQueue(deckFilter = 'all', typeFilter = 'all') {
  const now         = Date.now();
  const today       = typeof DateUtils !== 'undefined' ? DateUtils.today() : todayStr();
  const doneIds     = new Set(state.todayDone || []);
  const validDeckIds = new Set((state.decks || []).map(d => d.id));

  // FIX #2B: treat 0 as "use default"
  const rawLimit = state.settings?.newCardsPerDay;
  let dailyNewLimit;
  if (rawLimit === null || rawLimit === undefined || rawLimit === 0) {
    if (rawLimit === 0) console.warn('[FC] newCardsPerDay is 0 — using default of 20');
    dailyNewLimit = 20;
  } else {
    dailyNewLimit = Math.max(1, Number(rawLimit));
  }

  // FIX #2C: subtract new cards already studied today
  const studiedNewToday = Object.values(state.sm2 || {}).filter(c => {
    if (!c.lastReviewedAt) return false;
    const ratedToday = (typeof DateUtils !== 'undefined'
      ? DateUtils.tsToDate(c.lastReviewedAt)
      : new Date(c.lastReviewedAt).toISOString().slice(0, 10)) === today;
    return ratedToday && Array.isArray(c.log) && c.log.length === 1;
  }).length;

  const remainingNewAllowed = Math.max(0, dailyNewLimit - studiedNewToday);

  const filterDeckIdSet = _buildFilterDeckIdSet(deckFilter);

  const relearningPile = [];
  const reviewPile     = [];
  const learningPile   = [];
  const newPile        = [];
  const viewOnlyPile   = [];

  for (const topic of state.topics || []) {
    if (!topic?.id || !topic?.title)                               continue;
    if (!topic.deckId || !validDeckIds.has(topic.deckId))          continue;
    if (filterDeckIdSet && !filterDeckIdSet.has(topic.deckId))     continue;

    const startMs = fcParseStartDateToMs(topic.startDate);
    if (startMs !== null && startMs > now)                         continue;

    // FIX #7: read-only lookup — no side effects during queue build
    const card = getCard(topic.id) || fsrsInit(topic.id);

    // ── Relearning ───────────────────────────────────────────────────────────
    if (card.pile === 'relearning') {
      if (fcIsDueByTimestampNow(card, now)) {
        relearningPile.push(fcTag(topic, { group: 'relearning', viewOnly: false }));
      }
      continue;
    }

    // ── Learning ─────────────────────────────────────────────────────────────
    if (card.pile === 'learning') {
      if (fcIsDueByTimestampNow(card, now)) {
        const stepIndex   = Number.isInteger(card.stepIndex) ? card.stepIndex : 0;
        const stepMinutes = fcGetLearningStepMinutes(card);
        learningPile.push(fcTag(topic, { group: 'learning', viewOnly: false, stepIndex, stepMinutes }));
      }
      continue;
    }

    // ── FIX #2A: New cards checked BEFORE doneIds ────────────────────────────
    if ((!card.pile || card.pile === 'new') && !card.lastReviewedAt) {
      newPile.push(fcTag(topic, { group: 'new', viewOnly: false }));
      continue;
    }

    // ── Already reviewed today → view-only ───────────────────────────────────
    if (doneIds.has(topic.id)) {
      viewOnlyPile.push(fcTag(topic, { group: 'viewOnly', viewOnly: true }));
      continue;
    }

    // ── Due review ───────────────────────────────────────────────────────────
    if (card.pile === 'review') {
      if (!fcIsDueByTimestampNow(card, now)) continue;
      const retention = fcGetReviewRetentionPercent(card);
      reviewPile.push(fcTag(topic, { group: 'review', viewOnly: false, retention }));
      continue;
    }
  }

  // Lowest retention first (most-forgotten gets studied first).
  reviewPile.sort((a, b) =>
    (a.__queueMeta?.retention ?? 100) - (b.__queueMeta?.retention ?? 100));

  // Earliest step index first.
  learningPile.sort((a, b) =>
    (a.__queueMeta?.stepIndex ?? 0) - (b.__queueMeta?.stepIndex ?? 0));

  const shuffledNew = [...newPile].sort(() => Math.random() - 0.5);

  // FIX #2C: use remainingNewAllowed instead of raw dailyNewLimit
  const newLimited  = shuffledNew.slice(0, remainingNewAllowed);
  const newOverflow = shuffledNew
    .slice(remainingNewAllowed)
    .filter(t => {
      const isDeckPreview = typeof isDeckPreviewUpcomingEnabled === 'function'
        ? isDeckPreviewUpcomingEnabled(t.deckId)
        : false;
      return isDeckPreview;
    })
    .map(t => fcTag(t, { ...(t.__queueMeta || {}), group: 'newOverflow', viewOnly: true }));

  viewOnlyPile.sort((a, b) => {
    const ca = getCard(b.id);
    const cb = getCard(a.id);
    return (ca?.lastReviewedAt || 0) - (cb?.lastReviewedAt || 0);
  });

  const dueCount = relearningPile.length + reviewPile.length + learningPile.length;
  const newCount = newLimited.length;

  if (typeFilter === 'due') {
    return {
      queue: [...relearningPile, ...reviewPile, ...learningPile, ...newLimited],
      dueCount,
      newCount,
      previewCount: 0,
    };
  }

  return {
    queue: [
      ...relearningPile,
      ...reviewPile,
      ...learningPile,
      ...newLimited,
      ...viewOnlyPile,
      ...newOverflow,
    ],
    dueCount,
    newCount,
    previewCount: viewOnlyPile.length + newOverflow.length,
  };
}

// ─── GLOBAL STATE ─────────────────────────────────────────────────────────────

if (typeof window.T === 'undefined') window.T = {};

Object.assign(window.T, {
  fcQueue:             window.T.fcQueue             || [],
  fcIdx:               window.T.fcIdx               || 0,
  fcAnswerShown:       window.T.fcAnswerShown        || false,
  fcResults:           window.T.fcResults            || { again: 0, hard: 0, good: 0, easy: 0 },
  fcHistory:           window.T.fcHistory            || [],
  fcRedoStack:         window.T.fcRedoStack          || [],
  fcSeconds:           window.T.fcSeconds            || 0,
  fcTimerInterval:     window.T.fcTimerInterval      || null,
  manualDateCallback:  window.T.manualDateCallback   || null,
  fcHotkeysBound:      window.T.fcHotkeysBound       || false,
  fcViewOnlyMode:      false,
  fcDueCount:          0,
  fcNewCount:          0,
  fcPreviewCount:      0,
  studyReturnDeckId:   window.T.studyReturnDeckId    || null,
  fcSessionRatedIds:   window.T.fcSessionRatedIds    || [],
  // Guards that prevent double-invocation of rate/navigate actions (see fixes
  // for skip-by-2 bug caused by inline onclick + delegated listener both firing).
  _fcRating:           false,
  _fcNavigating:       false,
});

// ─── SNAPSHOT / RESTORE ───────────────────────────────────────────────────────

function fcSnapshot(tid) {
  ensureCardState();
  const data = state.sm2[tid] || {};
  return JSON.parse(JSON.stringify(data));
}

/**
 * FIX #3: Only writes to state.sm2. Previously wrote to both state.sm2 and
 * state.fsrs, creating two sources of truth that diverged after any rating
 * (updateCard only writes to state.sm2). Now there is a single store.
 */
function fcRestore(tid, snap) {
  ensureCardState();
  state.sm2[tid] = JSON.parse(JSON.stringify(snap));
  // state.fsrs intentionally not written — single source of truth is state.sm2
}

// ─── RENDER FC IDLE (dropdown) ────────────────────────────────────────────────

function renderFC() {
  if (typeof refreshAllDeckSelects === 'function') refreshAllDeckSelects();

  const deckSel = el('fcDeckFilter');
  const typeSel = el('fcTypeFilter');
  if (!deckSel) return;

  deckSel.innerHTML = '<option value="all">Auto</option>';

  const allIds = new Set(state.decks.map(d => d.id));
  const roots  = state.decks.filter(d => !d.parentId || !allIds.has(d.parentId));

  function addOptions(parentId, depth) {
    state.decks
      .filter(d => d.parentId === parentId)
      .forEach(deck => {
        const opt       = document.createElement('option');
        opt.value       = deck.id;
        opt.textContent = '\u00a0'.repeat(depth * 3) + '\u2514 ' + deck.name;
        deckSel.appendChild(opt);
        addOptions(deck.id, depth + 1);
      });
  }

  roots.forEach(deck => {
    const opt       = document.createElement('option');
    opt.value       = deck.id;
    opt.textContent = deck.name;
    deckSel.appendChild(opt);
    addOptions(deck.id, 1);
  });

  if (!deckSel._fcAutoReloadBound) {
    deckSel.addEventListener('change', _fcScheduleAutoReload);
    deckSel._fcAutoReloadBound = true;
  }
  if (typeSel && !typeSel._fcAutoReloadBound) {
    typeSel.addEventListener('change', _fcScheduleAutoReload);
    typeSel._fcAutoReloadBound = true;
  }
}

let _fcAutoReloadTimer = null;

function _fcScheduleAutoReload() {
  if (_fcAutoReloadTimer) clearTimeout(_fcAutoReloadTimer);
  _fcAutoReloadTimer = setTimeout(() => {
    _fcAutoReloadTimer = null;
    loadFlashcards();
  }, FC_CONSTANTS.DROPDOWN_DEBOUNCE_MS);
}

// ─── LOAD FLASHCARDS ──────────────────────────────────────────────────────────

/**
 * Synchronises the dropdown value AFTER the queue is built, not before,
 * so there is no window where a stale dropdown value could trigger an
 * auto-reload via the 'change' listener.
 */
function loadFlashcards(deckId = null) {
  if (T.fcTimerInterval) {
    clearInterval(T.fcTimerInterval);
    T.fcTimerInterval = null;
  }

  const deckFilter = deckId || el('fcDeckFilter')?.value || 'all';
  const typeFilter = el('fcTypeFilter')?.value || 'all';

  const { queue, dueCount, newCount, previewCount } =
    buildFlashcardPriorityQueue(deckFilter, typeFilter);

  // Sync dropdown AFTER queue is built to avoid spurious auto-reload.
  const deckSel = el('fcDeckFilter');
  if (deckSel && deckFilter !== 'all') deckSel.value = deckFilter;

  if (!queue.length) {
    T.fcQueue            = [];
    T.fcDueCount         = 0;
    T.fcNewCount         = 0;
    T.fcPreviewCount     = 0;
    T.fcIdx              = 0;
    T.fcAnswerShown      = false;
    T.fcViewOnlyMode     = false;
    T.fcSessionRatedIds  = [];

    const idle = el('fcIdle');
    if (idle) {
      idle.classList.remove('hidden');
      const msg = idle.querySelector('.fc-idle-msg');
      if (msg) msg.textContent = 'No cards match these filters.';
    }
    el('fcSession')?.classList.add('hidden');
    el('fcDone')?.classList.add('hidden');
    return;
  }

  T.fcQueue            = queue;
  T.fcDueCount         = dueCount;
  T.fcNewCount         = newCount;
  T.fcPreviewCount     = previewCount;
  T.fcIdx              = 0;
  T.fcAnswerShown      = false;
  T.fcViewOnlyMode     = false;
  T.fcResults          = { again: 0, hard: 0, good: 0, easy: 0 };
  T.fcHistory          = [];
  T.fcRedoStack        = [];
  T.fcSeconds          = 0;
  T.fcSessionRatedIds  = [];

  console.log(`[FC] Due:${dueCount} New:${newCount} Preview:${previewCount} Total:${queue.length}`);

  T.fcTimerInterval = setInterval(() => {
    T.fcSeconds++;
    const timer = el('fcTimer');
    if (timer) timer.textContent =
      `${Math.floor(T.fcSeconds / 60)}:${p2(T.fcSeconds % 60)}`;
  }, FC_CONSTANTS.TIMER_INTERVAL_MS);

  el('fcIdle')?.classList.add('hidden');
  el('fcDone')?.classList.add('hidden');
  el('fcSession')?.classList.remove('hidden');

  updateUndoRedoBtns();
  renderFcCard();
}

// ─── OPEN SPECIFIC TOPIC ──────────────────────────────────────────────────────

function openFlashcardTopic(topicId, options = {}) {
  const topic = state.topics.find(t => t.id === topicId);
  if (!topic) return false;

  switchSection('flashcards');

  const deckFilterEl = el('fcDeckFilter');
  const dateFilterEl = el('fcDateFilter');
  if (deckFilterEl) deckFilterEl.value = options.deckFilter || 'all';
  if (dateFilterEl) dateFilterEl.value = options.dateFilter || 'all';

  if (typeof renderFC === 'function') renderFC();

  loadFlashcards();

  let idx = T.fcQueue.findIndex(c => c.id === topicId);

  if (idx === -1 && options.dateFilter && options.dateFilter !== 'all') {
    if (dateFilterEl) dateFilterEl.value = 'all';
    loadFlashcards();
    idx = T.fcQueue.findIndex(c => c.id === topicId);
  }

  if (idx === -1) {
    const fallback = state.topics.find(t => t.id === topicId);
    if (!fallback) return false;

    T.fcQueue.push(fcTag(fallback, { group: 'viewOnly', viewOnly: true }));
    T.fcPreviewCount = (T.fcPreviewCount || 0) + 1;
    idx = T.fcQueue.length - 1;

    if (!T.fcTimerInterval) {
      T.fcSeconds = 0;
      T.fcTimerInterval = setInterval(() => {
        T.fcSeconds++;
        const timer = el('fcTimer');
        if (timer) timer.textContent =
          `${Math.floor(T.fcSeconds / 60)}:${p2(T.fcSeconds % 60)}`;
      }, FC_CONSTANTS.TIMER_INTERVAL_MS);
    }

    el('fcIdle')?.classList.add('hidden');
    el('fcDone')?.classList.add('hidden');
    el('fcSession')?.classList.remove('hidden');
  }

  if (idx === -1) return false;

  T.fcIdx         = idx;
  T.fcAnswerShown = false;
  renderFcCard();
  return true;
}

// ─── RENDER CURRENT CARD ──────────────────────────────────────────────────────

function renderFcCard() {
  const q = T.fcQueue[T.fcIdx];
  if (!q) return;

  const deck      = state.decks.find(d => d.id === q.deckId) || FC_CONSTANTS.FALLBACK_DECK;
  const card      = ensureCard(q.id); // ensureCard is correct here — we're about to study it
  const meta      = q.__queueMeta || {};
  const isPreview = Boolean(meta.viewOnly);

  T.fcViewOnlyMode = isPreview;

  // ── Pile badge ────────────────────────────────────────────────────────────
  const pb = el('fcPileBadge');
  if (pb) {
    pb.className = 'fc-pile-badge';
    if (isPreview) {
      pb.textContent = meta.group === 'newOverflow'
        ? 'View Only · Preview (ratings disabled)'
        : 'View Only · Reviewed Today';
      pb.classList.add('pile-preview');
    } else if (meta.group === 'relearning') {
      pb.textContent = 'Relearning';
      pb.classList.add('pile-learning');
    } else if (meta.group === 'review') {
      pb.textContent = `Review · ${Math.round(meta.retention ?? fcGetReviewRetentionPercent(card))}%`;
      pb.classList.add('pile-review');
    } else if (meta.group === 'learning') {
      pb.textContent = `Learning · ${Math.round(meta.stepMinutes ?? fcGetLearningStepMinutes(card))}m`;
      pb.classList.add('pile-learning');
    } else if (meta.group === 'new' || !card.pile || card.pile === 'new') {
      pb.textContent = 'New';
      pb.classList.add('pile-new');
    } else {
      const stab = card.state ? Math.round(card.state.stability) : 0;
      const ret  = Math.round(fcGetReviewRetentionPercent(card));
      pb.textContent = `Review · ${ret}% · S:${stab}d`;
      pb.classList.add('pile-review');
    }
  }

  // ── Deck tag ──────────────────────────────────────────────────────────────
  const dt = el('fcDeckTag');
  if (dt) {
    dt.textContent = deck.name;
    dt.style.setProperty('--deck-color', deck.color);
    dt.classList.add('deck-tag');
  }

  // ── Progress ──────────────────────────────────────────────────────────────
  const prog = el('fcProg');
  if (prog) prog.textContent = `${T.fcIdx + 1} / ${T.fcQueue.length}`;

  const pbFill = el('fcPbFill');
  if (pbFill) pbFill.style.width = `${(T.fcIdx / T.fcQueue.length) * 100}%`;

  // ── Question / answer ─────────────────────────────────────────────────────
  const fcQ     = el('fcQ');
  const fcA     = el('fcA');
  const qTitle  = q.title   || q.question || '';
  const qAnswer = q.content || q.answer   || '';

  if (q.type === 'cloze') {
    if (fcQ) fcQ.innerHTML = typeof renderClozeQ === 'function'
      ? renderClozeQ(qTitle) : qTitle;
    if (fcA) fcA.innerHTML = typeof renderClozeA === 'function'
      ? renderClozeA(qTitle) : qTitle;
  } else {
    if (fcQ) fcQ.textContent = qTitle;
    if (fcA) fcA.textContent = qAnswer || '— No additional notes —';
  }

  // ── Card image ────────────────────────────────────────────────────────────
  const fcImg = el('fcCardImage');
  if (fcImg) {
    if (q.image) {
      fcImg.src = q.image;
      fcImg.classList.remove('hidden');
    } else {
      fcImg.classList.add('hidden');
    }
  }

  fcResetCardUI();
  updateUndoRedoBtns();
  if (!isPreview) updateRatingButtonIntervals();
  // Re-bind the delegated rating listener each render so it stays attached
  // even if the container was re-created in the DOM.
  bindRatingButtons();
  ensureFlashcardButtonsVisible();
}

function fcResetCardUI() {
  // Reset the JS flag alongside the DOM so they can never diverge.
  T.fcAnswerShown = false;
  el('fcQ')?.classList.remove('hidden');
  el('fcAnswerArea')?.classList.add('hidden');
  el('fcShowRow')?.classList.remove('hidden');
  el('fcNextRow')?.classList.add('hidden');
  el('fcRatingRow')?.classList.add('hidden');
  el('fcSession')?.classList.remove('hidden');
  el('fcDone')?.classList.add('hidden');
}

// ─── RATING BUTTON LABELS ─────────────────────────────────────────────────────

function updateRatingButtonIntervals() {
  const q = T.fcQueue[T.fcIdx];
  if (!q) return;
  const card = ensureCard(q.id);

  let labels;
  if (typeof getButtonLabels === 'function') {
    labels = getButtonLabels(card);
  } else {
    const isRelearning = card.pile === 'relearning';
    const steps        = isRelearning
      ? FC_CONSTANTS.DEFAULT_RELEARNING_STEPS
      : FC_CONSTANTS.DEFAULT_LEARNING_STEPS;
    const stepIdx      = card.stepIndex || 0;

    const fmtMins = m => m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
    const fmtDays = d =>
      d < 7   ? `${d}d` :
      d < 30  ? `${Math.round(d / 7)}w` :
      d < 365 ? `${Math.round(d / 30)}mo` : `${Math.round(d / 365)}y`;

    const pile = card.pile || 'new';

    if (pile === 'learning' || pile === 'relearning') {
      const clamped = Math.min(stepIdx, steps.length - 1);
      const cur     = steps[clamped];
      const next    = steps[clamped + 1] || cur;
      labels = {
        again: fmtMins(steps[0]),
        hard:  fmtMins(Math.round((cur + next) / 2)),
        good:  stepIdx + 1 >= steps.length ? fmtDays(1) : fmtMins(steps[stepIdx + 1]),
        easy:  fmtDays(FC_CONSTANTS.EASY_INTERVAL_DAYS),
      };
    } else if (pile === 'new') {
      const cur  = steps[0];
      const next = steps[1] || steps[0];
      labels = {
        again: fmtMins(cur),
        hard:  fmtMins(Math.round((cur + next) / 2)),
        good:  steps.length > 1 ? fmtMins(steps[1]) : fmtDays(1),
        easy:  fmtDays(FC_CONSTANTS.EASY_INTERVAL_DAYS),
      };
    } else {
      labels = {
        again: fmtMins(FC_CONSTANTS.DEFAULT_RELEARNING_STEPS[0]),
        hard: '~1d', good: '~2d', easy: '~4d',
      };
    }
  }

  document.querySelectorAll('.fc-rating-row .rate-btn').forEach(btn => {
    let rating = 'again';
    if (btn.classList.contains('r-hard')) rating = 'hard';
    else if (btn.classList.contains('r-good')) rating = 'good';
    else if (btn.classList.contains('r-easy')) rating = 'easy';
    const span = btn.querySelector('span');
    if (span && labels[rating]) span.textContent = labels[rating];
  });
}

// ─── SHOW ANSWER ──────────────────────────────────────────────────────────────

function fcShowAnswer() {
  if (!T.fcQueue.length || T.fcIdx < 0 || T.fcIdx >= T.fcQueue.length) {
    console.warn('[FC] No valid card to show answer for');
    return;
  }

  const q = T.fcQueue[T.fcIdx];
  if (!q) return;

  el('fcQ')?.classList.add('hidden');
  el('fcAnswerArea')?.classList.remove('hidden');
  el('fcShowRow')?.classList.add('hidden');
  el('fcNextRow')?.classList.remove('hidden');

  const deck = state.decks.find(d => d.id === q.deckId);

  if (deck?.scheduleMode === 'manual') {
    el('fcRatingRow')?.classList.add('hidden');
    T.manualDateCallback = date => {
      if (!date) return;
      const snapshot = fcSnapshot(q.id);
      const card     = ensureCard(q.id);

      if (!card.firstSeenAt) card.firstSeenAt = Date.now();

      const manualNextReviewAt = new Date(date).getTime();
      card.nextReviewAt        = manualNextReviewAt;
      card.lastReviewedAt      = Date.now();
      card.pile                = 'review';

      // FIX #5: store 'manual' rating + actual timestamp so redo can replay correctly
      T.fcHistory.push({
        idx:               T.fcIdx,
        snapshot,
        rating:            'manual',
        manualNextReviewAt,
        resultsBefore:     { ...T.fcResults },
      });
      T.fcRedoStack = [];
      T.fcResults.good++;

      if (!T.fcSessionRatedIds.includes(q.id)) T.fcSessionRatedIds.push(q.id);
      if (!state.todayDone.includes(q.id)) state.todayDone.push(q.id);
      if (window.IndexManager?.scheduleRebuild) window.IndexManager.scheduleRebuild();
      if (typeof recordReview === 'function') recordReview();
      if (typeof saveImmediate === 'function') saveImmediate();
      advanceFcCard();
    };
    openModal('manualDateModal');
    const nextDate = el('manualNextDate');
    if (nextDate) nextDate.value = addDays(todayStr(), 1);
  } else {
    if (!T.fcViewOnlyMode) el('fcRatingRow')?.classList.remove('hidden');
  }

  T.fcAnswerShown = true;
  ensureFlashcardButtonsVisible();
}

function ensureFlashcardButtonsVisible() {
  const target = el('fcRatingRow')?.classList.contains('hidden')
    ? el('fcShowRow')
    : el('fcRatingRow');
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── RATE CARD ────────────────────────────────────────────────────────────────

function fcRate(rating) {
  // Guard against double-invocation caused by an inline onclick attribute on
  // the button AND the delegated listener on fcRatingRow both firing for the
  // same click. The flag resets asynchronously so rapid-but-intentional presses
  // (e.g. keyboard shortcuts) still work correctly.
  if (T._fcRating) return;
  T._fcRating = true;
  setTimeout(() => { T._fcRating = false; }, 0);

  // FIX #6: check __queueMeta.viewOnly at moment of rating — not the stale
  // T.fcViewOnlyMode which may reflect the previous card if a hotkey fires
  // during a render.
  const currentCard = T.fcQueue[T.fcIdx];
  const isViewOnly  = currentCard?.__queueMeta?.viewOnly ?? T.fcViewOnlyMode;

  if (isViewOnly) {
    if (typeof showToast === 'function') showToast('View-only mode — ratings disabled.', 'info');
    return;
  }

  const q = T.fcQueue[T.fcIdx];
  if (!q) return;

  const snapshot = fcSnapshot(q.id);
  const card     = ensureCard(q.id);

  if (!card.firstSeenAt) card.firstSeenAt = Date.now();

  const gradeMap = { again: 0, hard: 1, good: 2, easy: 3 };
  const grade    = gradeMap[rating] ?? 2;

  try {
    updateCard(q.id, grade, state.sm2);
    T.fcResults[rating]++;
  } catch (err) {
    console.warn('[FC] Rating update failed:', err);
  }

  T.fcHistory.push({
    idx:           T.fcIdx,
    snapshot,
    rating,
    resultsBefore: { ...T.fcResults, [rating]: T.fcResults[rating] - 1 },
  });
  T.fcRedoStack = [];

  if (!T.fcSessionRatedIds.includes(q.id)) T.fcSessionRatedIds.push(q.id);
  if (!state.todayDone.includes(q.id)) state.todayDone.push(q.id);
  if (window.IndexManager?.scheduleRebuild) window.IndexManager.scheduleRebuild();
  if (typeof recordReview  === 'function') recordReview();
  if (typeof saveImmediate === 'function') saveImmediate();
  advanceFcCard();
}

// ─── NAVIGATION ───────────────────────────────────────────────────────────────

function navigateFcCard(delta) {
  // Guard against double-invocation (same root cause as fcRate guard above).
  if (T._fcNavigating) return;
  T._fcNavigating = true;
  setTimeout(() => { T._fcNavigating = false; }, 0);

  const newIdx = T.fcIdx + delta;
  if (newIdx < 0 || newIdx >= T.fcQueue.length) return;
  T.fcIdx         = newIdx;
  T.fcAnswerShown = false;
  fcResetCardUI();
  renderFcCard();
}

const fcPrevCard = () => navigateFcCard(-1);
const fcNextCard = () => navigateFcCard(1);

// ─── ADVANCE TO NEXT CARD ─────────────────────────────────────────────────────

/**
 * FIX #9: Before advancing, scan ahead in the queue for any learning/relearning
 * cards whose timer has now expired. Move them to just after the current
 * position so they reappear at the right time within the session rather than
 * being silently skipped.
 */
function advanceFcCard() {
  const now = Date.now();

  // Re-queue expired learning/relearning cards
  for (let i = T.fcIdx + 2; i < T.fcQueue.length; i++) {
    const item = T.fcQueue[i];
    if (item?.__queueMeta?.requeued) continue;

    // Use getCard (read-only) to check the current live state
    const card = getCard(item.id);
    if (!card) continue;
    if (
      (card.pile === 'learning' || card.pile === 'relearning') &&
      fcIsDueByTimestampNow(card, now)
    ) {
      item.__queueMeta = { ...item.__queueMeta, requeued: true };
      T.fcQueue.splice(i, 1);
      T.fcQueue.splice(T.fcIdx + 1, 0, item);
    }
  }

  T.fcIdx++;
  if (T.fcIdx >= T.fcQueue.length) {
    showFcDone();
  } else {
    T.fcAnswerShown = false;
    fcResetCardUI();
    renderFcCard();
  }
  updateUndoRedoBtns();
}

// ─── SESSION COMPLETE (Done screen) ───────────────────────────────────────────

function showFcDone() {
  if (T.fcTimerInterval) {
    clearInterval(T.fcTimerInterval);
    T.fcTimerInterval = null;
  }

  el('fcSession')?.classList.add('hidden');
  el('fcDone')?.classList.remove('hidden');

  const r        = T.fcResults;
  const total    = r.again + r.hard + r.good + r.easy || 1;
  const m        = Math.floor(T.fcSeconds / 60);
  const s        = T.fcSeconds % 60;
  const retained = Math.round(((r.hard + r.good + r.easy) / total) * 100);

  const stats = el('fcdStats');
  if (stats) {
    stats.innerHTML = `
      <div class="fcd-stat">
        <div class="fcd-sv" style="color:var(--red)">${r.again}</div>
        <div class="fcd-sl">Again</div>
      </div>
      <div class="fcd-stat">
        <div class="fcd-sv" style="color:var(--amb)">${r.hard}</div>
        <div class="fcd-sl">Hard</div>
      </div>
      <div class="fcd-stat">
        <div class="fcd-sv" style="color:var(--grn)">${r.good}</div>
        <div class="fcd-sl">Good</div>
      </div>
      <div class="fcd-stat">
        <div class="fcd-sv" style="color:var(--acc)">${r.easy}</div>
        <div class="fcd-sl">Easy</div>
      </div>
      <div class="fcd-stat">
        <div class="fcd-sv">${retained}%</div>
        <div class="fcd-sl">Retained</div>
      </div>
      <div class="fcd-stat">
        <div class="fcd-sv">${m}:${p2(s)}</div>
        <div class="fcd-sl">Time</div>
      </div>
    `;
  }

  el('fcDone')?.querySelector('.fc-done-buttons')?.remove();

  const buttonDiv = document.createElement('div');
  buttonDiv.className  = 'fc-done-buttons';
  buttonDiv.style.cssText = 'display:flex;gap:12px;margin-top:20px;justify-content:center;flex-wrap:wrap;';

  // ── View Again ─────────────────────────────────────────────────────────────
  const ratedIds      = [...T.fcSessionRatedIds];
  const hasRatedCards = ratedIds.length > 0;

  if (hasRatedCards) {
    const viewAgainBtn       = document.createElement('button');
    viewAgainBtn.className   = 'btn-primary';
    viewAgainBtn.textContent = '👁️ View Again';
    viewAgainBtn.onclick = () => {
      const ratedSet    = new Set(ratedIds);
      const replayQueue = T.fcQueue
        .filter(c => ratedSet.has(c.id))
        .map(c => fcTag(c, { ...(c.__queueMeta || {}), viewOnly: true, group: 'viewOnly' }));

      if (!replayQueue.length) return;

      T.fcQueue        = replayQueue;
      T.fcViewOnlyMode = true;
      T.fcIdx          = 0;
      T.fcAnswerShown  = false;
      T.fcResults      = { again: 0, hard: 0, good: 0, easy: 0 };
      T.fcHistory      = [];
      T.fcRedoStack    = [];

      el('fcDone')?.classList.add('hidden');
      el('fcSession')?.classList.remove('hidden');

      fcResetCardUI();
      renderFcCard();
    };
    buttonDiv.appendChild(viewAgainBtn);
  }

  // ── Back to Deck ───────────────────────────────────────────────────────────
  const returnDeckId = T.studyReturnDeckId;
  const backBtn      = document.createElement('button');
  backBtn.className   = 'btn-secondary';
  backBtn.textContent = '← Back to Deck';

  backBtn.onclick = () => {
    if (T.fcTimerInterval) {
      clearInterval(T.fcTimerInterval);
      T.fcTimerInterval = null;
    }
    T.fcQueue           = [];
    T.fcIdx             = 0;
    T.fcAnswerShown     = false;
    T.fcSessionRatedIds = [];
    T.studyReturnDeckId = null;

    switchSection('decks');

    if (returnDeckId) {
      setTimeout(() => {
        if (typeof openDeckDetail === 'function') openDeckDetail(returnDeckId);
      }, 100);
    }
  };
  buttonDiv.appendChild(backBtn);

  el('fcDone')?.appendChild(buttonDiv);
}

// ─── STOP SESSION (manual exit) ───────────────────────────────────────────────

/**
 * FIX #10: saveImmediate is called on manual exit so any ratings from the
 * interrupted session are persisted. Previously, an unfinished session could
 * lose the last few ratings if the user exited before the debounced save fired.
 */
function stopFcSession() {
  if (T.fcTimerInterval) {
    clearInterval(T.fcTimerInterval);
    T.fcTimerInterval = null;
  }
  T.fcAnswerShown     = false;
  T.fcQueue           = [];
  T.fcIdx             = 0;
  T.fcSessionRatedIds = [];
  el('fcSession')?.classList.add('hidden');
  el('fcIdle')?.classList.remove('hidden');
  el('fcDone')?.classList.add('hidden');
  if (typeof saveImmediate === 'function') saveImmediate(); // FIX #10
}

// ─── UNDO / REDO UI HELPERS ───────────────────────────────────────────────────

function updateUndoRedoBtns() {
  const undoBtn = el('fcUndoBtn');
  const redoBtn = el('fcRedoBtn');
  if (undoBtn) undoBtn.classList.toggle('disabled', T.fcHistory.length === 0);
  if (redoBtn) redoBtn.classList.toggle('disabled', T.fcRedoStack.length === 0);
}

// ─── STABLE MODULE-LEVEL RATING HANDLER ──────────────────────────────────────
/**
 * Defined at module level so removeEventListener can reliably remove it.
 * A delegated listener on the container means one handler covers all buttons
 * regardless of how many times the DOM is re-rendered.
 */
function handleRatingClick(e) {
  const btn = e.target.closest('.rate-btn');
  if (!btn) return;
  let rating = 'again';
  if (btn.classList.contains('r-hard')) rating = 'hard';
  else if (btn.classList.contains('r-good')) rating = 'good';
  else if (btn.classList.contains('r-easy')) rating = 'easy';
  fcRate(rating);
}

/**
 * Safe to call on every render — remove+add with a stable reference guarantees
 * exactly one active listener at all times, even if fcRatingRow was re-created.
 */
function bindRatingButtons() {
  const container = el('fcRatingRow');
  if (!container) return;
  container.removeEventListener('click', handleRatingClick);
  container.addEventListener('click', handleRatingClick);
}

// ─── EVENT SETUP ─────────────────────────────────────────────────────────────

/**
 * All one-off buttons use onclick= (assignment) so repeated calls are safe —
 * assignment replaces rather than stacks. Rating buttons use the stable
 * delegated listener via bindRatingButtons().
 */
function setupFlashcardEvents() {
  const againBtn   = el('fcAgainBtn');
  const showBtn    = el('fcShowBtn');
  const undoBtn    = el('fcUndoBtn');
  const redoBtn    = el('fcRedoBtn');
  const prevBtn    = el('fcPrevBtn');
  const nextBtn    = el('fcNextBtn');
  const navNextBtn = el('fcNavNextBtn');

  if (againBtn)   againBtn.onclick   = () => loadFlashcards();
  if (showBtn)    showBtn.onclick    = fcShowAnswer;
  if (undoBtn)    undoBtn.onclick    = fcUndo;
  if (redoBtn)    redoBtn.onclick    = fcRedo;
  if (prevBtn)    prevBtn.onclick    = fcPrevCard;
  if (nextBtn)    nextBtn.onclick    = fcNextCard;
  if (navNextBtn) navNextBtn.onclick = fcNextCard;

  const confirmManualDate = el('confirmManualDate');
  if (confirmManualDate) {
    confirmManualDate.onclick = () => {
      const dateInput = el('manualNextDate');
      if (dateInput && T.manualDateCallback) {
        T.manualDateCallback(dateInput.value);
        T.manualDateCallback = null;
        if (typeof closeModal === 'function') closeModal('manualDateModal');
      }
    };
  }

  bindRatingButtons();

  // Single persistent keyboard listener — always remove before re-adding.
  document.removeEventListener('keydown', handleFlashcardHotkeys);
  document.addEventListener('keydown', handleFlashcardHotkeys);
  T.fcHotkeysBound = true;
}

// ─── KEYBOARD HANDLER ─────────────────────────────────────────────────────────

/**
 * Space key: show answer if not shown yet, advance if answer is already visible.
 *
 * ROOT CAUSE OF BUG (now fixed):
 *   The old code used:
 *     const answerIsVisible = !el('fcAnswerArea')?.classList.contains('hidden');
 *   When el('fcAnswerArea') returns null (element missing or ID mismatch),
 *   optional-chaining returns undefined, and !undefined === true — so the code
 *   always thought the answer was visible and jumped straight to fcNextCard(),
 *   skipping fcShowAnswer() entirely.
 *
 * FIX: use a helper that treats a missing element as "answer not shown" and
 * cross-checks with T.fcAnswerShown so either source of truth can catch it.
 *
 * Space-key / synthetic-click race:
 *   Browsers fire a synthetic click on a focused <button> on keyup AFTER the
 *   keydown handler runs, so e.preventDefault() alone doesn't suppress it.
 *   We blur any focused button at the top of the space handler so the keyup
 *   has nothing to activate.
 *
 * FIX #6: isViewOnly reads __queueMeta.viewOnly from the live queue entry at
 * keystroke time, not the potentially-stale T.fcViewOnlyMode.
 */
function handleFlashcardHotkeys(e) {
  const activeTag = document.activeElement?.tagName;
  const isTyping  = activeTag === 'INPUT' || activeTag === 'TEXTAREA'
    || document.activeElement?.isContentEditable;
  if (isTyping) return;

  const flashcardsVisible = !el('section-flashcards')?.classList.contains('hidden');
  const sessionVisible    = !el('fcSession')?.classList.contains('hidden');
  if (!flashcardsVisible || !sessionVisible) return;

  const key  = String(e.key || '').toLowerCase();
  const code = e.code || '';

  if (code === 'Space' || key === ' ') {
    e.preventDefault();

    // Blur any focused button so the browser's keyup-triggered synthetic click
    // cannot fire on it after we've handled the action here.
    if (document.activeElement instanceof HTMLButtonElement) {
      document.activeElement.blur();
    }

    // ── BUG FIX: safe answer-visibility check ───────────────────────────────
    // Previous code: !el('fcAnswerArea')?.classList.contains('hidden')
    // When el('fcAnswerArea') is null, optional-chaining returns undefined,
    // !undefined === true, so it always looked "visible" → always called
    // fcNextCard() and never showed the answer.
    //
    // Fixed: if the element is absent, fall back to T.fcAnswerShown so we
    // never mistakenly treat a missing element as "answer already visible".
    const answerAreaEl    = el('fcAnswerArea');
    const answerIsVisible = answerAreaEl
      ? !answerAreaEl.classList.contains('hidden')
      : T.fcAnswerShown;

    if (answerIsVisible) {
      fcNextCard();
    } else {
      fcShowAnswer();
    }
    return;
  }

  if (T.fcAnswerShown) {
    // FIX #6: read viewOnly from the live queue entry, not T.fcViewOnlyMode
    const currentQueueEntry = T.fcQueue[T.fcIdx];
    const isViewOnly        = currentQueueEntry?.__queueMeta?.viewOnly ?? false;

    if (!isViewOnly) {
      const ratings = {
        digit1: 'again', numpad1: 'again', '1': 'again',
        digit2: 'hard',  numpad2: 'hard',  '2': 'hard',
        digit3: 'good',  numpad3: 'good',  '3': 'good',
        digit4: 'easy',  numpad4: 'easy',  '4': 'easy',
      };
      const picked = ratings[code.toLowerCase()] || ratings[key];
      if (picked) {
        e.preventDefault();
        fcRate(picked);
        return;
      }
    }
  }

  if (code === 'ArrowLeft' || key === 'arrowleft') {
    e.preventDefault();
    fcPrevCard();
    return;
  }
  if (code === 'ArrowRight' || key === 'arrowright') {
    e.preventDefault();
    fcNextCard();
    return;
  }
  if (e.ctrlKey && (code === 'KeyZ' || key === 'z')) {
    e.preventDefault();
    fcUndo();
    return;
  }
  if (e.ctrlKey && (code === 'KeyY' || key === 'y')) {
    e.preventDefault();
    fcRedo();
    return;
  }
}

// ─── UNDO / REDO ─────────────────────────────────────────────────────────────

function fcUndo() {
  if (!T.fcHistory.length) return;

  const last = T.fcHistory.pop();
  const tid  = T.fcQueue[last.idx]?.id;
  if (!tid) return;

  fcRestore(tid, last.snapshot);

  // FIX #4: filter removes ALL occurrences, not just the first.
  state.todayDone = state.todayDone.filter(id => id !== tid);

  if (last.rating && last.rating !== 'manual') {
    T.fcResults[last.rating] = Math.max(0, T.fcResults[last.rating] - 1);
  } else if (last.rating === 'manual') {
    T.fcResults.good = Math.max(0, T.fcResults.good - 1);
  }

  const ri = T.fcSessionRatedIds.indexOf(tid);
  if (ri !== -1) T.fcSessionRatedIds.splice(ri, 1);

  if (typeof recalcHistoryFromCards !== 'undefined') {
    recalcHistoryFromCards();
  } else {
    const today = todayStr();
    state.history[today] = Math.max(0, (state.history[today] || 0) - 1);
  }

  T.fcRedoStack.push({ ...last });
  T.fcIdx         = last.idx;
  T.fcAnswerShown = false;
  fcResetCardUI();
  renderFcCard();

  if (typeof saveImmediate === 'function') saveImmediate();
  if (typeof recalcStreak  === 'function') recalcStreak();
  updateUndoRedoBtns();
}

function fcRedo() {
  if (!T.fcRedoStack.length) return;

  const item = T.fcRedoStack.pop();
  const q    = T.fcQueue[item.idx];
  if (!q) return;

  // FIX #5: manual-date ratings replay the stored timestamp, not a FSRS
  // Good calculation. Previously redo always called updateCard with grade=2
  // (Good), which discarded the manually chosen date and scheduled the card
  // completely differently from the original action.
  if (item.rating === 'manual' && item.manualNextReviewAt) {
    const card = ensureCard(q.id);
    card.nextReviewAt   = item.manualNextReviewAt;
    card.lastReviewedAt = Date.now();
    card.pile           = 'review';
    T.fcResults.good++;
  } else {
    const gradeMap = { again: 0, hard: 1, good: 2, easy: 3 };
    const grade    = gradeMap[item.rating] ?? 2;
    updateCard(q.id, grade, state.sm2);
    if (item.rating) T.fcResults[item.rating]++;
  }

  if (!T.fcSessionRatedIds.includes(q.id)) T.fcSessionRatedIds.push(q.id);
  if (!state.todayDone.includes(q.id)) state.todayDone.push(q.id);
  if (typeof recordReview === 'function') recordReview();

  T.fcHistory.push(item);
  T.fcIdx         = item.idx + 1;
  T.fcAnswerShown = false;

  if (T.fcIdx >= T.fcQueue.length) {
    if (T.fcTimerInterval) clearInterval(T.fcTimerInterval);
    showFcDone();
  } else {
    renderFcCard();
  }

  if (typeof saveImmediate === 'function') saveImmediate();
  if (typeof recalcStreak  === 'function') recalcStreak();
  updateUndoRedoBtns();
}

// ─── AUTO-INITIALIZE ON DOM READY ────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupFlashcardEvents);
} else {
  setupFlashcardEvents();
}

// ─── EXPORTS (global) ────────────────────────────────────────────────────────

window.renderFC                     = renderFC;
window.loadFlashcards               = loadFlashcards;
window.openFlashcardTopic           = openFlashcardTopic;
window.renderFcCard                 = renderFcCard;
window.fcShowAnswer                 = fcShowAnswer;
window.fcRate                       = fcRate;
window.advanceFcCard                = advanceFcCard;
window.fcUndo                       = fcUndo;
window.fcRedo                       = fcRedo;
window.fcPrevCard                   = fcPrevCard;
window.fcNextCard                   = fcNextCard;
window.showFcDone                   = showFcDone;
window.stopFcSession                = stopFcSession;
window.updateUndoRedoBtns           = updateUndoRedoBtns;
window.setupFlashcardEvents         = setupFlashcardEvents;
window.buildFlashcardPriorityQueue  = buildFlashcardPriorityQueue;
window.fcGetNextReviewAtMs          = fcGetNextReviewAtMs;
window.fcIsDueByTimestampNow        = fcIsDueByTimestampNow;
window.getCard                      = getCard;
window.ensureCard                   = ensureCard;
window.bindRatingButtons            = bindRatingButtons;