'use strict';

// ============================================
// AUTO-REFRESH TIMER
// Calls renderToday() every 5 s so learning cards with short steps
// reappear on schedule.  No longer paused when a session is running
// because sessions are now handled entirely inside the Flashcards section.
// ============================================

let _todayRefreshTimer = null;

function startTodayAutoRefresh() {
  stopTodayAutoRefresh();
  _todayRefreshTimer = setInterval(() => renderToday(), 5_000);
}

function stopTodayAutoRefresh() {
  if (_todayRefreshTimer !== null) {
    clearInterval(_todayRefreshTimer);
    _todayRefreshTimer = null;
  }
}

// ============================================
// LIVE TIMER  (per-second badge countdown on minute-step cards)
// ============================================

let _liveTimerInterval = null;

/**
 * Formats remaining milliseconds as a human-readable string.
 *   <= 0      → "Ready"
 *   < 60 000  → "Xs"
 *   otherwise → "Xm Ys"
 */
function formatTimeRemaining(ms) {
  if (ms <= 0) return 'Ready';
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function startLiveTimers() {
  stopLiveTimers();
  _liveTimerInterval = setInterval(() => {
    // Only tick while the Today section is the active view.
    const todaySection = document.getElementById('section-today');
    if (!todaySection?.classList.contains('active')) return;

    const now = Date.now();
    document.querySelectorAll(
      '.due-item[data-pile="learning"], .due-item[data-pile="relearning"]'
    ).forEach(item => {
      const badge      = item.querySelector('.due-pile');
      const nextReview = Number(item.dataset.nextReviewAt);
      if (!badge) return;

      const remaining = nextReview ? nextReview - now : 0;
      const isReady   = remaining <= 0;
      const prefix    = item.dataset.pile === 'relearning' ? '🔁 Relearning' : '📖 Learning';

      if (isReady) {
        badge.textContent = `${prefix} · ✅ Ready`;
        badge.style.color = '#22c55e';
      } else {
        badge.textContent = `${prefix} · ⏱️ ${formatTimeRemaining(remaining)}`;
        badge.style.color = '';
      }
    });
  }, 1_000);
}

function stopLiveTimers() {
  if (_liveTimerInterval !== null) {
    clearInterval(_liveTimerInterval);
    _liveTimerInterval = null;
  }
}

// ============================================
// CLOZE FALLBACKS
// ============================================

if (typeof renderClozeQ === 'undefined') {
  window.renderClozeQ = (title) =>
    (typeof esc === 'function' ? esc : (s) => s)(
      title.replace(/\{\{c\d+::(.+?)\}\}/g, '[...]')
    );
}
if (typeof renderClozeA === 'undefined') {
  window.renderClozeA = (title) =>
    title.replace(/\{\{c\d+::(.+?)\}\}/g, (_, ans) =>
      `<span class="cloze-answer">${typeof esc === 'function' ? esc(ans) : ans}</span>`
    );
}

// ============================================
// HEADER BUTTONS
// Sessions now live in Flashcards, so we only track whether the
// session queue contains any actionable cards.
// ============================================

function updateTodayHeaderButtons(sessionTotal) {
  const startBtn    = el('startSessionBtn');
  const reviewedBtn = el('reviewAgainHeaderBtn');

  // Start Session button: visible only when there are cards ready to study.
  if (startBtn) startBtn.classList.toggle('hidden', sessionTotal === 0);

  // "View Again" / reviewed-cards button: always accessible once cards exist.
  if (reviewedBtn) reviewedBtn.classList.remove('hidden');
}

// ============================================
// HELPERS
// ============================================

function parseStartDateToMs(startDate) {
  if (!startDate || typeof startDate !== 'string') return null;
  const parsed = parseD(startDate);
  const ms     = parsed instanceof Date ? parsed.getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function getReviewRetentionPercent(card) {
  try {
    if (!card?.state?.stability || !card?.lastReviewedAt) return 100;
    const stability   = Number(card.state.stability);
    const elapsedDays = Math.max(0, (Date.now() - Number(card.lastReviewedAt)) / 86_400_000);
    if (!Number.isFinite(stability) || stability <= 0 || !Number.isFinite(elapsedDays)) return 100;
    const retention = Math.pow(0.9, elapsedDays / stability) * 100;
    if (!Number.isFinite(retention)) return 100;
    return Math.max(0, Math.min(100, retention));
  } catch {
    return 100;
  }
}

function getLearningStepMinutes(card) {
  const isRelearning = card?.pile === 'relearning';
  const steps = isRelearning
    ? (window.SCHEDULER_CONFIG?.RELEARNING_STEPS || [10])
    : (window.SCHEDULER_CONFIG?.LEARNING_STEPS   || [1, 10]);
  const stepIndex = Number.isInteger(card?.stepIndex) ? card.stepIndex : 0;
  const safeIndex = Math.max(0, Math.min(stepIndex, steps.length - 1));
  return Number(steps[safeIndex]) || 0;
}

function queueTopicWithMeta(topic, meta = {}) {
  return { ...topic, __queueMeta: { ...meta } };
}

function getNextReviewAtMs(card) {
  const raw = card?.nextReviewAt;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isDueByTimestampNow(card, now = Date.now()) {
  if (!card?.state) {
    const nextMs = getNextReviewAtMs(card);
    return nextMs === null || nextMs <= now;
  }
  const nextMs = getNextReviewAtMs(card);
  if (nextMs === null) return true;
  return nextMs <= now;
}

function isStillLearning(card) {
  return card?.pile === 'learning' || card?.pile === 'relearning';
}

// ============================================
// VISUAL PRIORITY QUEUE  (used only for renderDueList)
//
// Includes ALL minute-step cards regardless of whether their timer
// has expired, so the user can see them and watch the countdown.
// This queue is NEVER used as a study session queue.
// ============================================

function buildTodayPriorityQueue(deckId = 'all') {
  const now           = Date.now();
  const dailyNewLimit = Math.max(0, Number(state.settings.newCardsPerDay || 0));
  const doneIds       = new Set(state.todayDone || []);
  const validDeckIds  = new Set((state.decks || []).map(d => d.id));
  const isDeckPreviewEnabled = typeof isDeckPreviewUpcomingEnabled === 'function'
    ? isDeckPreviewUpcomingEnabled
    : () => false;

  const relearningPile = [];
  const reviewPile     = [];
  const learningPile   = [];
  const newPile        = [];

  for (const topic of state.topics || []) {
    if (!topic?.id || !topic?.title) continue;
    if (!topic.deckId || !validDeckIds.has(topic.deckId)) continue;
    if (deckId !== 'all' && !isInDeck(topic.deckId, deckId)) continue;

    const startMs = parseStartDateToMs(topic.startDate);
    if (startMs !== null && startMs > now) continue;

    const card = ensureCard(topic.id);

    // Learning: always shown in Today list (timer controls interactivity, not visibility)
    if (card.pile === 'learning') {
      const stepIndex   = Number.isInteger(card.stepIndex) ? card.stepIndex : 0;
      const stepMinutes = getLearningStepMinutes(card);
      learningPile.push(queueTopicWithMeta(topic, {
        group: 'learning',
        viewOnly: false,
        stepIndex,
        stepMinutes,
      }));
      continue;
    }

    // Relearning: always shown in Today list (same reason as above)
    if (card.pile === 'relearning') {
      relearningPile.push(queueTopicWithMeta(topic, { group: 'relearning', viewOnly: false }));
      continue;
    }

    // Cards already reviewed today are excluded from the visual list.
    if (doneIds.has(topic.id)) continue;

    if (card.pile === 'review') {
      if (!isDueByTimestampNow(card, now)) continue;
      const retention = getReviewRetentionPercent(card);
      reviewPile.push(queueTopicWithMeta(topic, { group: 'review', viewOnly: false, retention }));
      continue;
    }

    if (card.pile === 'new' && !card.firstSeenAt) {
      newPile.push(queueTopicWithMeta(topic, { group: 'new', viewOnly: false }));
    }
  }

  reviewPile.sort((a, b)   => (a.__queueMeta?.retention ?? 100) - (b.__queueMeta?.retention ?? 100));
  learningPile.sort((a, b) => (a.__queueMeta?.stepIndex  ?? 0)   - (b.__queueMeta?.stepIndex  ?? 0));

  const shuffledNew = [...newPile].sort(() => Math.random() - 0.5);
  const newLimited  = shuffledNew.slice(0, dailyNewLimit);
  const newOverflow = shuffledNew
    .slice(dailyNewLimit)
    .filter(t => isDeckPreviewEnabled(t.deckId))
    .map(t => queueTopicWithMeta(t, {
      ...(t.__queueMeta || {}),
      group: 'newOverflow',
      viewOnly: true,
    }));

  const queue = [
    ...relearningPile,
    ...reviewPile,
    ...learningPile,
    ...newLimited,
    ...newOverflow,
  ];

  return {
    queue,
    dueCount:     relearningPile.length + reviewPile.length + learningPile.length,
    newCount:     newLimited.length,
    previewCount: newOverflow.length,
  };
}

// ============================================
// SESSION QUEUE  (used by Start Session)
//
// Derived from the visual queue but with one extra filter:
// minute-step cards whose nextReviewAt is still in the future are
// removed, because the user cannot rate them until the timer expires.
// Review, new, and preview cards pass through unchanged.
// ============================================

function buildSessionQueue(deckId = 'all') {
  const now = Date.now();
  const { queue } = buildTodayPriorityQueue(deckId);

  return queue.filter(topic => {
    const meta = topic.__queueMeta || {};
    if (meta.group === 'learning' || meta.group === 'relearning') {
      // Only include minute-step cards whose timer has already expired.
      const card = ensureCard(topic.id);
      return isDueByTimestampNow(card, now);
    }
    // All other card types (review, new, preview) are always included.
    return true;
  });
}

// ============================================
// RENDER TODAY
// ============================================

function renderToday() {
  const today     = todayStr();
  const dateLabel = el('todayDateLabel');
  if (dateLabel) {
    dateLabel.textContent = parseD(today).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
  }

  const filterDeck = el('todayDeckFilter')?.value || 'all';
  const { queue, dueCount, newCount, previewCount } = buildTodayPriorityQueue(filterDeck);

  const done  = state.todayDone ? state.todayDone.length : 0;
  const total = queue.length;

  console.log(`[Today] Visual queue — Due:${dueCount} New:${newCount} Preview:${previewCount} Total:${total}`);

  el('statDue').textContent        = dueCount;
  el('statNew').textContent        = newCount;
  el('statDone').textContent       = done;
  el('statStreakToday').textContent = state.currentStreak || 0;
  el('streakNum').textContent      = state.currentStreak || 0;
  el('mobStreak').textContent      = state.currentStreak || 0;

  const goal    = state.settings.dailyGoal || 20;
  const goalPct = Math.min(100, Math.round((done / goal) * 100));
  el('dgmFill').style.width = goalPct + '%';
  el('dgmNums').textContent = `${done}/${goal}`;

  const badge = el('todayBadge');
  if (badge) {
    badge.textContent = total;
    badge.classList.toggle('hidden', total === 0);
  }

  // Header buttons: use session queue count (excludes non-expired minute-step cards)
  // so "Start Session" only activates when at least one card is actually rateable.
  const sessionQueue = buildSessionQueue(filterDeck);
  console.log(`[Today] Session queue (actionable) — ${sessionQueue.length} cards`);
  updateTodayHeaderButtons(sessionQueue.length);

  renderDueList(queue, done, total, { dueCount, newCount, previewCount });
}

// ============================================
// DUE & NEW HELPERS  (kept for external callers)
// ============================================

function getDueCardsForToday(deckId = 'all') {
  const today = todayStr();
  return state.topics.filter(t => {
    if (!t?.id || !t?.title) return false;
    if (!t.deckId || !state.decks.some(d => d.id === t.deckId)) return false;
    if (t.startDate && t.startDate > today) return false;
    if (deckId !== 'all' && !isInDeck(t.deckId, deckId)) return false;
    if (state.todayDone.includes(t.id)) return false;
    const card = ensureCard(t.id);
    if (card.pile === 'new' || !card.state) return false;
    return isDueByTimestampNow(card);
  });
}

function getNewCardsForToday(deckId = 'all', limit = 20) {
  const today = todayStr();
  return state.topics.filter(t => {
    if (!t?.id || !t?.title) return false;
    if (!t.deckId || !state.decks.some(d => d.id === t.deckId)) return false;
    if (t.startDate && t.startDate > today) return false;
    if (deckId !== 'all' && !isInDeck(t.deckId, deckId)) return false;
    if (state.todayDone.includes(t.id)) return false;
    const card = ensureCard(t.id);
    return card.pile === 'new' && !card.firstSeenAt;
  }).slice(0, limit);
}

// ============================================
// RENDER DUE LIST
// ============================================

function renderDueList(queue, done, total, counts = { dueCount: 0, newCount: 0, previewCount: 0 }) {
  const list = el('todayDueList');
  if (!list) return;

  list.innerHTML = '';

  if (total === 0) {
    const msg = done === 0
      ? 'All caught up! No reviews due today.'
      : `All ${done} reviews done for today! 🎉`;
    list.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">${done === 0 ? '✨' : '🎉'}</div>
        <div class="es-msg">${msg}</div>
      </div>`;
    return;
  }

  const heading = document.createElement('div');
  heading.className   = 'due-list-heading';
  heading.textContent = `Due cards: ${counts.dueCount} · New cards: ${counts.newCount} · Preview: ${counts.previewCount}`;
  list.appendChild(heading);

  const doneIds = new Set(state.todayDone || []);
  const now     = Date.now();

  queue.forEach(t => {
    if (!t?.id) return;

    // Learning / relearning cards are never in todayDone — keep them visible.
    const meta            = t.__queueMeta || {};
    const isLearningGroup = meta.group === 'learning' || meta.group === 'relearning';
    if (!isLearningGroup && doneIds.has(t.id)) return;

    try {
      const deck = state.decks.find(d => d.id === t.deckId)
        || { name: 'Uncategorized', color: '#7B6EF6' };
      const card = ensureCard(t.id);

      const pileClass = meta.group === 'newOverflow' || meta.group === 'viewOnly' ? 'vp'
        : meta.group === 'relearning' ? 'rlp'
        : meta.group === 'learning'   ? 'lp'
        : meta.group === 'review'     ? 'rp'
        : 'np';

      // data-pile drives the live timer and the click guard.
      const dataPile = meta.group === 'learning'   ? 'learning'
                     : meta.group === 'relearning' ? 'relearning'
                     : meta.group === 'review'     ? 'review'
                     : 'other';

      const nextMs = getNextReviewAtMs(card);

      // Build the initial badge label; the live timer will update it each second.
      let pileLabel  = '';
      let badgeStyle = '';

      if (meta.group === 'newOverflow') {
        pileLabel = '👁️ Preview Mode · View Only';
      } else if (meta.group === 'viewOnly') {
        pileLabel = '👁️ Reviewed Today · View Only';
      } else if (meta.group === 'relearning') {
        const remaining = nextMs ? nextMs - now : 0;
        if (remaining > 0) {
          pileLabel = `🔁 Relearning · ⏱️ ${formatTimeRemaining(remaining)}`;
        } else {
          pileLabel  = '🔁 Relearning · ✅ Ready';
          badgeStyle = 'color:#22c55e';
        }
      } else if (meta.group === 'review') {
        pileLabel = `🔁 Review · ${Math.round(meta.retention ?? getReviewRetentionPercent(card))}%`;
      } else if (meta.group === 'learning') {
        const remaining = nextMs ? nextMs - now : 0;
        if (remaining > 0) {
          pileLabel = `📖 Learning · ⏱️ ${formatTimeRemaining(remaining)}`;
        } else {
          pileLabel  = '📖 Learning · ✅ Ready';
          badgeStyle = 'color:#22c55e';
        }
      } else {
        pileLabel = '🆕 New';
      }

      const div = document.createElement('div');
      div.className       = 'due-item';
      div.dataset.topicId = t.id;
      div.dataset.pile    = dataPile;
      if (nextMs !== null) div.dataset.nextReviewAt = String(nextMs);

      div.innerHTML = `
        <div class="due-dot" style="background:${deck.color}"></div>
        <div class="due-title">${esc(t.title || '(Untitled)')}</div>
        <div class="due-deck-name">${esc(deck.name)}</div>
        <div class="due-pile ${pileClass}" style="${badgeStyle}">${pileLabel}</div>
      `;
      list.appendChild(div);
    } catch (err) {
      console.warn('[renderDueList] Skipped malformed topic:', t?.id, err);
    }
  });
}

// ============================================
// START SESSION
//
// No longer runs an inline session inside Today.
// Switches to the Flashcards section with the appropriate filters
// pre-set and immediately loads the session queue.
// ============================================

function startSession() {
  const filterDeck   = el('todayDeckFilter')?.value || 'all';
  const sessionQueue = buildSessionQueue(filterDeck);

  if (!sessionQueue.length) {
    const msg = 'No cards are ready to review right now. Check back once a timer expires.';
    if (typeof showToast === 'function') showToast(msg, 'info');
    else alert(msg);
    return;
  }

  console.log(`[Today] Start Session → delegating to Flashcards. Deck: "${filterDeck}" | Cards: ${sessionQueue.length}`);

  // ── 1. Switch to Flashcards section ────────────────────────────────────────
  if (typeof switchSection === 'function') switchSection('flashcards');

  // ── 2. Sync deck filter ─────────────────────────────────────────────────────
  const deckSel = el('fcDeckFilter');
  if (deckSel) deckSel.value = filterDeck;

  // ── 3. Set type filter to "Due Only" ────────────────────────────────────────
  //    The Flashcards queue builder respects typeFilter === 'due':
  //    it includes only due review cards, new cards (up to daily limit),
  //    and expired minute-step cards — matching buildSessionQueue's logic.
  const typeSel = el('fcTypeFilter');
  if (typeSel) typeSel.value = 'due';

  // ── 4. Load the session immediately ─────────────────────────────────────────
  //    Pass deckId so loadFlashcards doesn't rely on DOM timing.
  if (typeof loadFlashcards === 'function') {
    loadFlashcards(filterDeck !== 'all' ? filterDeck : null);
  } else {
    console.error('[Today] loadFlashcards() is not available. Ensure flashcards.js is loaded first.');
  }
}

// ============================================
// VIEW AGAIN  (replays today's rated cards, view-only)
//
// Uses state.todayDone so it covers every card rated during the day,
// whether the session started from Today or from a deck's Study button.
// Does NOT include unexpired minute-step cards.
// ============================================

function reviewAgain() {
  const replayIds = (T.lastSessQueueIds?.length)
    ? T.lastSessQueueIds
    : (state.todayDone || []);

  const cards = replayIds
    .map(id => state.topics.find(t => t.id === id))
    .filter(Boolean);

  if (!cards.length) {
    if (typeof showToast === 'function') showToast('No reviewed cards to replay yet.', 'info');
    return;
  }

  // Delegate view-only replay to Flashcards: build a view-only queue
  // and inject it directly into the Flashcard session state.
  const replayQueue = cards.map(t =>
    queueTopicWithMeta(t, { group: 'viewOnly', viewOnly: true })
  );

  if (typeof switchSection === 'function') switchSection('flashcards');

  // Inject the queue into the shared T object used by flashcards.js.
  Object.assign(window.T || {}, {
    fcQueue:           replayQueue,
    fcViewOnlyMode:    true,
    fcIdx:             0,
    fcAnswerShown:     false,
    fcResults:         { again: 0, hard: 0, good: 0, easy: 0 },
    fcHistory:         [],
    fcRedoStack:       [],
    fcSessionRatedIds: [],
  });

  el('fcIdle')?.classList.add('hidden');
  el('fcDone')?.classList.add('hidden');
  el('fcSession')?.classList.remove('hidden');

  if (typeof renderFcCard === 'function') renderFcCard();
  else console.error('[Today] renderFcCard() not available. Ensure flashcards.js is loaded first.');
}

// ============================================
// SHOW REVIEWED CARDS  (legacy alias kept for any external callers)
// ============================================

function showReviewedCards() {
  reviewAgain();
}

// ============================================
// RESET TODAY'S REVIEWS
// ============================================

function resetTodayReviews() {
  const today          = todayStr();
  state.todayDone      = [];
  state.history[today] = 0;

  if (window.T) {
    T.lastSessQueueIds  = [];
    T.fcQueue           = [];
    T.fcIdx             = 0;
    T.fcAnswerShown     = false;
    T.fcSessionRatedIds = [];
    T.fcResults         = { again: 0, hard: 0, good: 0, easy: 0 };
  }

  if (typeof recalcStreak  === 'function') recalcStreak();
  if (typeof saveImmediate === 'function') saveImmediate();

  renderToday();
}

// ============================================
// EVENT SETUP
// ============================================

function setupTodayEvents() {
  // Primary action buttons
  el('startSessionBtn')?.addEventListener('click', startSession);
  el('reviewAgainHeaderBtn')?.addEventListener('click', reviewAgain);
  el('resetTodayReviewsBtn')?.addEventListener('click', resetTodayReviews);

  // Deck filter changes re-render the visual list and recompute button state.
  el('todayDeckFilter')?.addEventListener('change', renderToday);

  // ── Card click handler ──────────────────────────────────────────────────────
  el('todayDueList')?.addEventListener('click', (e) => {
    const row     = e.target.closest('.due-item');
    const topicId = row?.dataset?.topicId;
    if (!topicId) return;

    const pile = row.dataset.pile;

    // Timer-expiry guard for minute-step cards.
    if (pile === 'learning' || pile === 'relearning') {
      const nextReviewAt = Number(row.dataset.nextReviewAt);
      if (nextReviewAt && nextReviewAt > Date.now()) {
        const remaining = nextReviewAt - Date.now();
        const msg       = `Please wait ${formatTimeRemaining(remaining)} before reviewing this card.`;
        if (typeof showToast === 'function') showToast(msg);
        else alert(msg);
        return;         // Block — timer not yet expired.
      }
      // Timer has expired: fall through and open Flashcards normally.
    }

    // Open Flashcards with the card pre-selected.
    const deckFilter = el('todayDeckFilter')?.value || 'all';
    if (typeof openFlashcardTopic === 'function') {
      openFlashcardTopic(topicId, { deckFilter, dateFilter: 'due' });
    } else {
      console.error('[Today] openFlashcardTopic() not available.');
    }
  });

  // Start live timers and auto-refresh when Today is mounted.
  startTodayAutoRefresh();
  startLiveTimers();
}

// ============================================
// EXPORTS
// ============================================

window.renderToday           = renderToday;
window.startSession          = startSession;
window.reviewAgain           = reviewAgain;
window.showReviewedCards     = showReviewedCards;
window.resetTodayReviews     = resetTodayReviews;
window.buildTodayPriorityQueue = buildTodayPriorityQueue;
window.buildSessionQueue     = buildSessionQueue;
window.setupTodayEvents      = setupTodayEvents;
window.startTodayAutoRefresh = startTodayAutoRefresh;
window.stopTodayAutoRefresh  = stopTodayAutoRefresh;
window.startLiveTimers       = startLiveTimers;
window.stopLiveTimers        = stopLiveTimers;
window.formatTimeRemaining   = formatTimeRemaining;
window.renderDueList         = renderDueList;
window.getDueCardsForToday   = getDueCardsForToday;
window.getNewCardsForToday   = getNewCardsForToday;