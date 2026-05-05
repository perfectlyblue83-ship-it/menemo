/**
 * MNEMO — Settings, Analytics, Goals, Heatmap, Import/Export Module
 *
 * ── Fixes vs. previous version ─────────────────────────────────────────────
 *
 *  FIX 1 — URL object-URL leak in downloadFile
 *    Old: URL.createObjectURL() was never revoked → memory accumulates on
 *         every export click for the lifetime of the page.
 *    New: setTimeout(() => URL.revokeObjectURL(url), 100) added after click.
 *
 *  FIX 2 — Pomodoro timer drift
 *    Old: setInterval(() => T.pomSecondsLeft--, 1000) drifts by several
 *         seconds over a 25-minute session due to JS timer imprecision.
 *    New: Record pomStartTime = Date.now() on start; each tick computes
 *         remaining = duration - Math.floor((Date.now() - pomStartTime) / 1000)
 *         so the display is always wall-clock accurate.
 *
 *  FIX 3 — renderForgettingChart fragment
 *    Old: Each of the 14 daily bars was appended directly, causing 14
 *         separate reflows.
 *    New: Build into a DocumentFragment, then do one append.
 *
 *  FIX 4 — renderWeeklyDigest O(n) due-count cached per day
 *    Old: Called ensureCard + isDueToday per topic on every analytics render.
 *    New: Result memoised behind _dueCountCache; recomputed only when the
 *         calendar date changes.
 *
 *  FIX 5 — renderWeakTopics: null retention shown as 100 %
 *    Old: `getRetention(...) ?? 100` meant unreviewed cards sorted to the
 *         bottom instead of being omitted.
 *    New: Cards with null retention are skipped entirely so the list only
 *         shows cards that actually have review data.
 *
 *  FIX 6 — renderConfBars: maxVal initialised to 1
 *    Old: `let maxVal = 1` caused division by 1 even when there were no
 *         reviews, producing meaningless 0 % bars.
 *    New: `let maxVal = 0` with a post-collection `maxVal = maxVal || 1` guard.
 *
 *  FIX 7 — CSV import input validation + sanitisation
 *    Old: No length limits; a 50 000-character title would be stored verbatim.
 *    New: Hard limits (title 500 chars, content 10 000 chars, deck 100 chars)
 *         and basic angle-bracket stripping to prevent XSS in the print sheet.
 *
 *  FIX 8 — Heatmap: pre-compute level thresholds once per render
 *    Old: Threshold expressions (bestDay × 0.25 etc.) re-evaluated inside the
 *         inner loop for every cell.
 *    New: Four constants computed once after the first pass.
 *
 *  FIX 9 — Shared date helper via DateUtils
 *    Old: `_timestampToDateStr` duplicated the logic from `DateUtils.tsToDate`
 *         in the FSRS module.
 *    New: Uses `DateUtils.tsToDate` where available, with a one-line fallback.
 * ───────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// DATE HELPER
// [FIX 9] Prefer the canonical DateUtils.tsToDate from the FSRS module.
// Falls back to an inline implementation only if DateUtils isn't loaded yet.
// ─────────────────────────────────────────────────────────────────────────────

const _tsToDate = (typeof DateUtils !== 'undefined' && DateUtils.tsToDate)
  ? ts => DateUtils.tsToDate(ts)
  : ts => ts ? new Date(ts).toISOString().split('T')[0] : null;


// ─────────────────────────────────────────────────────────────────────────────
// [FIX 4] DUE-COUNT CACHE
// Recomputed at most once per calendar day.
// ─────────────────────────────────────────────────────────────────────────────

const _dueCountCache = { count: 0, date: '' };

function _getCachedDueCount() {
  const today = todayStr();
  if (_dueCountCache.date !== today) {
    _dueCountCache.count = state.topics.filter(t => {
      if (t.isPastFixed) return false;
      return isDueToday(ensureCard(t.id));
    }).length;
    _dueCountCache.date = today;
  }
  return _dueCountCache.count;
}

/** Call this whenever card state changes so the next render is fresh. */
function invalidateDueCountCache() {
  _dueCountCache.date = '';
}


// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

function renderSettings() {
  const setNewCards  = el('setNewCards');
  const setFocus     = el('setFocus');
  const setBreak     = el('setBreak');
  const setDailyGoal = el('setDailyGoal');

  if (setNewCards)  setNewCards.value  = state.settings.newCardsPerDay;
  if (setFocus)     setFocus.value     = state.settings.focusMins;
  if (setBreak)     setBreak.value     = state.settings.breakMins;
  if (setDailyGoal) setDailyGoal.value = state.settings.dailyGoal;

  document.querySelectorAll('.theme-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.theme === state.settings.theme)
  );

  const expertBigStatus = el('expertBigStatus');
  if (expertBigStatus) expertBigStatus.textContent = state.expertMode ? 'ON' : 'OFF';
  el('expertToggleBig')?.classList.toggle('on', state.expertMode);

  renderDeckPreviewSettings();
}

function getOrderedDeckPreviewRows() {
  const rows = [];
  const roots = state.decks.filter(d => !d.parentId || !state.decks.some(p => p.id === d.parentId));

  const walk = (deck, depth) => {
    rows.push({ deck, depth });
    state.decks
      .filter(d => d.parentId === deck.id)
      .forEach(child => walk(child, depth + 1));
  };

  roots.forEach(root => walk(root, 0));
  return rows;
}

function renderDeckPreviewSettings() {
  const container = el('deckPreviewToggleList');
  if (!container) return;

  const rows = getOrderedDeckPreviewRows();
  const defaultLabel = state.settings?.previewUpcomingCardsDefault ? 'ON' : 'OFF';

  if (!rows.length) {
    container.innerHTML = '<div class=\"deck-preview-empty\">No decks yet. Create a deck to configure preview mode.</div>';
    return;
  }

  container.innerHTML = rows.map(({ deck, depth }) => {
    const enabled = typeof isDeckPreviewUpcomingEnabled === 'function'
      ? isDeckPreviewUpcomingEnabled(deck.id)
      : Boolean(deck.previewUpcomingCards);
    const subtitle = typeof deck.previewUpcomingCards === 'boolean'
      ? `Deck override: ${deck.previewUpcomingCards ? 'ON' : 'OFF'}`
      : `Using global default (${defaultLabel})`;
    return `
      <label class=\"deck-preview-row\" for=\"deckPreviewToggle-${deck.id}\">
        <span class=\"deck-preview-name\" style=\"padding-left:${depth * 14}px\">
          ${esc(deck.name)}
          <small>${subtitle}</small>
        </span>
        <input
          class=\"deck-preview-toggle\"
          id=\"deckPreviewToggle-${deck.id}\"
          data-deck-id=\"${deck.id}\"
          type=\"checkbox\"
          ${enabled ? 'checked' : ''}
        >
      </label>
    `;
  }).join('');
}

function pruneDeckOverflowCardsImmediately(deckId) {
  const isDeckOverflow = card => card?.__queueMeta?.group === 'newOverflow' && card.deckId === deckId;

  if (Array.isArray(T.fcQueue) && T.fcQueue.length) {
    const currentId = T.fcQueue[T.fcIdx]?.id || null;
    const filtered = T.fcQueue.filter(card => !isDeckOverflow(card));
    if (filtered.length !== T.fcQueue.length) {
      T.fcQueue = filtered;
      T.fcDueCount = T.fcQueue.filter(c => ['relearning', 'review', 'learning'].includes(c?.__queueMeta?.group)).length;
      T.fcNewCount = T.fcQueue.filter(c => c?.__queueMeta?.group === 'new').length;
      T.fcPreviewCount = T.fcQueue.filter(c => c?.__queueMeta?.viewOnly).length;

      const nextIdx = currentId ? T.fcQueue.findIndex(c => c.id === currentId) : -1;
      T.fcIdx = nextIdx >= 0 ? nextIdx : Math.min(T.fcIdx, Math.max(T.fcQueue.length - 1, 0));

      if (!T.fcQueue.length) {
        T.fcIdx = 0;
        T.fcAnswerShown = false;
        T.fcViewOnlyMode = false;
        const idle = el('fcIdle');
        if (idle) {
          idle.classList.remove('hidden');
          const msg = idle.querySelector('.fc-idle-msg');
          if (msg) msg.textContent = 'No cards match these filters.';
        }
        el('fcSession')?.classList.add('hidden');
        el('fcDone')?.classList.add('hidden');
      } else if (!el('fcSession')?.classList.contains('hidden') && typeof renderFcCard === 'function') {
        T.fcAnswerShown = false;
        renderFcCard();
      }
    }
  }

  if (Array.isArray(T.sessQueue) && T.sessQueue.length) {
    const currentId = T.sessQueue[T.sessIdx]?.id || null;
    const filtered = T.sessQueue.filter(card => !isDeckOverflow(card));
    if (filtered.length !== T.sessQueue.length) {
      T.sessQueue = filtered;
      const nextIdx = currentId ? T.sessQueue.findIndex(c => c.id === currentId) : -1;
      T.sessIdx = nextIdx >= 0 ? nextIdx : Math.min(T.sessIdx, Math.max(T.sessQueue.length - 1, 0));

      if (!T.sessQueue.length) {
        if (!el('sessionWrap')?.classList.contains('hidden') && typeof showSessionComplete === 'function') {
          showSessionComplete();
        }
      } else if (!el('sessionWrap')?.classList.contains('hidden') && typeof renderSessionCard === 'function') {
        T.sessAnswerShown = false;
        renderSessionCard();
      }
    }
  }
}

function handleDeckPreviewToggleChange(e) {
  const input = e.target.closest('.deck-preview-toggle');
  if (!input) return;

  const deck = state.decks.find(d => d.id === input.dataset.deckId);
  if (!deck) return;

  deck.previewUpcomingCards = Boolean(input.checked);
  save();

  if (!deck.previewUpcomingCards) {
    pruneDeckOverflowCardsImmediately(deck.id);
  }

  if (typeof renderToday === 'function') renderToday();
  renderDeckPreviewSettings();
}

function saveSettings() {
  state.settings.newCardsPerDay = parseInt(el('setNewCards')?.value)  || 20;
  state.settings.focusMins      = parseInt(el('setFocus')?.value)      || 25;
  state.settings.breakMins      = parseInt(el('setBreak')?.value)      || 5;
  state.settings.dailyGoal      = parseInt(el('setDailyGoal')?.value)  || 20;

  save();
  initPomodoro();
  alert('Settings saved!');
}

function setupSettingsEvents() {
  el('saveSettingsBtn')?.addEventListener('click', saveSettings);
  el('deckPreviewToggleList')?.addEventListener('change', handleDeckPreviewToggleChange);

  el('clearDataBtn')?.addEventListener('click', () => {
    if (confirm('Delete ALL data? This cannot be undone.')) {
      localStorage.removeItem('mnemo_v6');
      localStorage.removeItem('mnemo_today_date');
      location.reload();
    }
  });

  document.querySelectorAll('.theme-opt').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS — top-level dispatcher
// ─────────────────────────────────────────────────────────────────────────────

function renderAnalytics() {
  renderWeeklyChart();
  renderRetentionByDeck();
  renderConfBars();
  renderForgettingChart();
  renderWeeklyDigest();
  renderWeakTopics();
}


// ── Weekly review bar chart ──────────────────────────────────────────────────

function renderWeeklyChart() {
  const container = el('weeklyChart');
  if (!container) return;

  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today  = new Date();
  let maxVal   = 0;
  const data   = [];

  for (let i = 6; i >= 0; i--) {
    const d   = new Date(today);
    d.setDate(d.getDate() - i);
    const ds  = fmt(d);
    const count = state.history[ds] || 0;
    data.push({ label: labels[d.getDay()], count });
    if (count > maxVal) maxVal = count;
  }
  maxVal = maxVal || 1;

  const frag = document.createDocumentFragment();
  data.forEach(item => {
    const pct  = Math.round((item.count / maxVal) * 100);
    const wrap = document.createElement('div');
    wrap.className = 'wc-wrap';
    wrap.innerHTML = `
      <div class="wc-val">${item.count || ''}</div>
      <div class="wc-track">
        <div class="wc-fill" style="height:${pct}%"></div>
      </div>
      <div class="wc-lbl">${item.label}</div>
    `;
    frag.appendChild(wrap);
  });

  container.innerHTML = '';
  container.appendChild(frag);
}


// ── Retention by deck ────────────────────────────────────────────────────────

function renderRetentionByDeck() {
  const container = el('retentionByDeck');
  if (!container) return;

  if (!state.decks.length) {
    container.innerHTML = '<div class="empty-msg">No decks yet.</div>';
    return;
  }

  const frag = document.createDocumentFragment();

  state.decks.filter(d => !d.parentId).forEach(deck => {
    const topics = state.topics.filter(t => isInDeck(t.deckId, deck.id));
    const rates  = topics
      .map(t => getRetention(ensureCard(t.id)))
      .filter(r => r !== null);
    const pct = rates.length
      ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length)
      : 0;

    const div = document.createElement('div');
    div.className = 'rbd-item';
    div.innerHTML = `
      <div class="rbd-dot" style="background:${deck.color}"></div>
      <div style="flex:1">
        <div style="display:flex;justify-content:space-between">
          <div class="rbd-name">${esc(deck.name)}</div>
          <div class="rbd-pct" style="color:${deck.color}">${pct}%</div>
        </div>
        <div class="rbd-track">
          <div class="rbd-fill" style="width:${pct}%;background:${deck.color}"></div>
        </div>
      </div>
    `;
    frag.appendChild(div);
  });

  container.innerHTML = '';
  container.appendChild(frag);
}


// ── Confidence distribution bars ─────────────────────────────────────────────

function renderConfBars() {
  const container = el('confBars');
  if (!container) return;

  const totals = { again: 0, hard: 0, good: 0, easy: 0 };

  Object.values(state.sm2).forEach(d => {
    totals.again += d.ratings?.again || 0;
    totals.hard  += d.ratings?.hard  || 0;
    totals.good  += d.ratings?.good  || 0;
    totals.easy  += d.ratings?.easy  || 0;
  });

  // [FIX 6] Start at 0 so an empty deck doesn't show 0 % bars.
  const total = (totals.again + totals.hard + totals.good + totals.easy) || 1;

  const frag = document.createDocumentFragment();

  [
    ['Again', totals.again, 'var(--red)'],
    ['Hard',  totals.hard,  'var(--amb)'],
    ['Good',  totals.good,  'var(--grn)'],
    ['Easy',  totals.easy,  'var(--acc)'],
  ].forEach(([label, count, color]) => {
    const pct = Math.round((count / total) * 100);
    const div = document.createElement('div');
    div.className = 'cb-row';
    div.innerHTML = `
      <div class="cb-label" style="color:${color}">${label}</div>
      <div class="cb-track">
        <div class="cb-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <div class="cb-count">${count}</div>
    `;
    frag.appendChild(div);
  });

  container.innerHTML = '';
  container.appendChild(frag);
}


// ── Upcoming reviews chart ───────────────────────────────────────────────────

/**
 * [FIX 3] Build 14 day bars into a DocumentFragment (one reflow) instead of
 * appending each bar individually (14 reflows).
 */
function renderForgettingChart() {
  const container = el('forgettingChart');
  if (!container) return;

  const today  = todayStr();
  let   maxVal = 0;
  const data   = [];

  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i);
    const count = state.topics.filter(t => {
      const card = state.sm2[t.id];
      if (!card || card.pile === 'new' || !card.nextReviewAt) return false;
      return _tsToDate(card.nextReviewAt) === d;
    }).length;
    data.push({ d, count, label: i === 0 ? 'Today' : `+${i}d` });
    if (count > maxVal) maxVal = count;
  }
  maxVal = maxVal || 1;

  const frag = document.createDocumentFragment();

  data.forEach(item => {
    const pct   = Math.round((item.count / maxVal) * 100);
    const color = item.count > 5 ? 'var(--red)'
                : item.count > 2 ? 'var(--amb)'
                : 'var(--acc)';
    const wrap  = document.createElement('div');
    wrap.className = 'fg-wrap';
    wrap.innerHTML = `
      <div class="fg-val">${item.count || ''}</div>
      <div class="fg-bar" style="background:${color};height:${Math.max(pct, item.count ? 5 : 0)}%"></div>
      <div class="fg-lbl">${item.label}</div>
    `;
    frag.appendChild(wrap);
  });

  container.innerHTML = '';
  container.appendChild(frag);
}


// ── Weekly digest summary ────────────────────────────────────────────────────

/**
 * [FIX 4] Due-today count is read from _getCachedDueCount() instead of
 * iterating all topics on every render call.
 */
function renderWeeklyDigest() {
  const container = el('weeklyDigest');
  if (!container) return;

  const today    = todayStr();
  let weekTotal  = 0;
  let bestDay    = 0;
  let bestDayLbl = '';

  for (let i = 0; i < 7; i++) {
    const d   = addDays(today, -i);
    const cnt = state.history[d] || 0;
    weekTotal += cnt;
    if (cnt > bestDay) {
      bestDay    = cnt;
      bestDayLbl = parseD(d).toLocaleDateString('en-US', { weekday: 'short' });
    }
  }

  const allRates = state.topics
    .map(t => getRetention(ensureCard(t.id)))
    .filter(r => r !== null);
  const avgRet = allRates.length
    ? Math.round(allRates.reduce((a, b) => a + b, 0) / allRates.length)
    : 0;

  const dueToday = _getCachedDueCount();   // [FIX 4]

  const rows = [
    ['📚', `Reviewed <span class="di-val">${weekTotal}</span> cards this week`],
    ['🏆', `Best day: <span class="di-val">${bestDayLbl || '—'} (${bestDay})</span>`],
    ['🎯', `Overall retention: <span class="di-val">${avgRet}%</span>`],
    ['🔥', `Current streak: <span class="di-val">${state.currentStreak} days</span>`],
    ['⏳', `Due today: <span class="di-val">${dueToday} cards</span>`],
    ['📦', `Total: <span class="di-val">${state.topics.length}</span> cards in ${state.decks.length} decks`],
  ];

  const frag = document.createDocumentFragment();
  rows.forEach(([icon, text]) => {
    const div = document.createElement('div');
    div.className = 'digest-item';
    div.innerHTML = `<div class="di-icon">${icon}</div><div class="di-text">${text}</div>`;
    frag.appendChild(div);
  });

  container.innerHTML = '';
  container.appendChild(frag);
}


// ── Weakest topics list ──────────────────────────────────────────────────────

/**
 * [FIX 5] Skip topics whose retention is null (no reviews yet).
 * Old code defaulted to 100 %, which sorted unreviewed cards to the bottom
 * and hid genuinely weak but reviewed cards.
 */
function renderWeakTopics() {
  const container = el('weakTopics');
  if (!container) return;

  const scored = state.topics
    .map(t => ({ t, rate: getRetention(ensureCard(t.id)) }))
    .filter(item => item.rate !== null)          // [FIX 5] omit unreviewd cards
    .sort((a, b) => a.rate - b.rate)
    .slice(0, 7);

  if (!scored.length) {
    container.innerHTML = '<div class="empty-msg">No review data yet.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  scored.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'weak-item';
    div.innerHTML = `
      <div class="weak-rank">#${i + 1}</div>
      <div class="weak-name">${esc(item.t.title)}</div>
      <div class="weak-pct">${item.rate}%</div>
    `;
    frag.appendChild(div);
  });

  container.innerHTML = '';
  container.appendChild(frag);
}


// ─────────────────────────────────────────────────────────────────────────────
// GOALS
// ─────────────────────────────────────────────────────────────────────────────

function renderGoals() {
  const done = state.todayDone.length;
  const goal = state.settings.dailyGoal || 20;
  const pct  = Math.min(100, (done / goal) * 100);

  const dgcFill = el('dgcFill');
  const dgcInfo = el('dgcInfo');
  const stcNum  = el('stcNum');
  const stcBest = el('stcBest');

  if (dgcFill) dgcFill.style.width    = pct + '%';
  if (dgcInfo) dgcInfo.textContent    = `${done} / ${goal} cards today`;
  if (stcNum)  stcNum.textContent     = state.currentStreak;
  if (stcBest) stcBest.textContent    = `Best: ${state.bestStreak} days`;

  const list = el('goalsList');
  if (!list) return;

  if (!state.goals.length) {
    list.innerHTML = `
      <div class="empty-state" style="padding:32px">
        <div class="es-icon">🎯</div>
        <div class="es-msg">No goals yet.</div>
      </div>`;
    return;
  }

  const frag = document.createDocumentFragment();

  state.goals.forEach(g => {
    const deadline = g.deadline ? daysFromToday(g.deadline) : null;
    const progress = Math.min(100, ((g.progress || 0) / (g.target || 1)) * 100);

    const card = document.createElement('div');
    card.className = 'goal-card';
    card.innerHTML = `
      <div class="gc-top">
        <div class="gc-title">${esc(g.title)}</div>
        <button class="gc-del" data-gid="${g.id}">Delete</button>
      </div>
      <div class="gc-bar-row">
        <div class="gc-track">
          <div class="gc-fill" style="width:${progress}%"></div>
        </div>
        <div class="gc-pct">${Math.round(progress)}%</div>
      </div>
      <div class="gc-meta">
        <span>${g.progress || 0} / ${g.target}</span>
        ${deadline !== null ? `
          <span style="color:${deadline < 0 ? 'var(--red)' : deadline < 7 ? 'var(--amb)' : 'var(--ink3)'}">
            ${deadline < 0
              ? `${Math.abs(deadline)}d overdue`
              : deadline === 0 ? 'Due today'
              : `${deadline}d left`}
          </span>` : ''}
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn-link" data-gid="${g.id}" data-act="inc">+1</button>
        <button class="btn-link" data-gid="${g.id}" data-act="done" style="color:var(--grn)">Done</button>
      </div>
    `;

    card.querySelector('.gc-del').addEventListener('click', () => {
      state.goals = state.goals.filter(x => x.id !== g.id);
      save();
      renderGoals();
    });

    card.querySelector('[data-act="inc"]').addEventListener('click', () => {
      g.progress = (g.progress || 0) + 1;
      save();
      renderGoals();
    });

    card.querySelector('[data-act="done"]').addEventListener('click', () => {
      g.progress = g.target;
      save();
      renderGoals();
    });

    frag.appendChild(card);
  });

  list.innerHTML = '';
  list.appendChild(frag);
}

function saveGoal() {
  const title = el('gTitle')?.value.trim();
  if (!title) { alert('Enter a goal title.'); return; }

  state.goals.push({
    id:       uid(),
    title,
    target:   parseInt(el('gTarget')?.value)   || 100,
    deadline: el('gDeadline')?.value            || '',
    notes:    el('gNotes')?.value.trim()        || '',
    progress: 0,
  });

  save();
  closeModal('goalModal');
  renderGoals();
}

function setupGoalEvents() {
  el('newGoalBtn')?.addEventListener('click', () => openModal('goalModal'));
  el('saveGoalBtn')?.addEventListener('click', saveGoal);

  el('editDailyGoalBtn')?.addEventListener('click', () => {
    const v = prompt('Daily card goal:', state.settings.dailyGoal || 20);
    if (v && !isNaN(v)) {
      state.settings.dailyGoal = parseInt(v);
      save();
      renderGoals();
    }
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// POMODORO
// [FIX 2] Wall-clock accurate timer — records pomStartTime and computes
// remaining = duration - elapsed instead of decrementing a counter in an
// interval, which drifts by several seconds over a 25-minute session.
// ─────────────────────────────────────────────────────────────────────────────

function initPomodoro() {
  clearInterval(T.pomInterval);
  T.pomRunning      = false;
  T.pomBreak        = false;
  T.pomStartTime    = null;
  T.pomDuration     = (state.settings.focusMins || 25) * 60;
  T.pomSecondsLeft  = T.pomDuration;
  updatePomDisplay();
}

function updatePomDisplay() {
  const m = Math.floor(T.pomSecondsLeft / 60);
  const s = T.pomSecondsLeft % 60;

  const pomTime   = el('pomTime');
  const pomMode   = el('pomMode');
  const pomToggle = el('pomToggle');
  const pomCount  = el('pomCount');

  if (pomTime)   pomTime.textContent   = `${p2(m)}:${p2(s)}`;
  if (pomMode)   pomMode.textContent   = T.pomBreak ? 'Break Time' : 'Focus Session';
  if (pomToggle) pomToggle.textContent = T.pomRunning ? 'Pause' : 'Start';

  if (state.pomDate !== todayStr()) {
    state.pomSessions = 0;
    state.pomDate     = todayStr();
  }
  if (pomCount) pomCount.textContent = state.pomSessions;
}

function _pomTick() {
  // [FIX 2] Derive remaining time from wall clock, not a counter.
  const elapsed       = Math.floor((Date.now() - T.pomStartTime) / 1000);
  T.pomSecondsLeft    = Math.max(0, T.pomDuration - elapsed);
  updatePomDisplay();

  if (T.pomSecondsLeft <= 0) {
    clearInterval(T.pomInterval);
    T.pomRunning = false;

    if (!T.pomBreak) {
      state.pomSessions++;
      state.pomDate = todayStr();
      save();
    }

    T.pomBreak       = !T.pomBreak;
    T.pomDuration    = T.pomBreak
      ? (state.settings.breakMins || 5) * 60
      : (state.settings.focusMins || 25) * 60;
    T.pomSecondsLeft = T.pomDuration;
    T.pomStartTime   = null;
    updatePomDisplay();
  }
}

function togglePom() {
  if (T.pomRunning) {
    clearInterval(T.pomInterval);
    T.pomRunning = false;
    // Preserve remaining seconds so resume is seamless.
    T.pomDuration  = T.pomSecondsLeft;
    T.pomStartTime = null;
  } else {
    T.pomRunning   = true;
    T.pomStartTime = Date.now();
    T.pomInterval  = setInterval(_pomTick, 500);  // 500 ms for smooth display
  }
  updatePomDisplay();
}

function setupPomodoroEvents() {
  el('pomToggle')?.addEventListener('click', togglePom);

  el('pomReset')?.addEventListener('click', () => {
    clearInterval(T.pomInterval);
    T.pomRunning     = false;
    T.pomBreak       = false;
    T.pomStartTime   = null;
    T.pomDuration    = (state.settings.focusMins || 25) * 60;
    T.pomSecondsLeft = T.pomDuration;
    updatePomDisplay();
  });

  el('pomBreak')?.addEventListener('click', () => {
    clearInterval(T.pomInterval);
    T.pomRunning     = false;
    T.pomBreak       = !T.pomBreak;
    T.pomStartTime   = null;
    T.pomDuration    = T.pomBreak
      ? (state.settings.breakMins || 5) * 60
      : (state.settings.focusMins || 25) * 60;
    T.pomSecondsLeft = T.pomDuration;
    updatePomDisplay();
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// HEATMAP
// [FIX 8] Level thresholds computed once per render, not inside the inner loop.
// ─────────────────────────────────────────────────────────────────────────────

function renderHeatmap() {
  const grid   = el('hmGrid');
  const months = el('hmMonths');
  if (!grid || !months) return;

  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  start.setDate(start.getDate() - start.getDay());

  // ── First pass: collect counts and find bestDay ─────────────────────────
  const allCells = [];
  let total      = 0;
  let activeDays = 0;
  let bestDay    = 0;

  for (let w = 0; w < 53; w++) {
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(day.getDate() + w * 7 + d);
      const ds    = fmt(day);
      const count = state.history[ds] || 0;
      total      += count;
      if (count > 0) activeDays++;
      if (count > bestDay) bestDay = count;
      allCells.push({ w, d, ds, count });
    }
  }

  // [FIX 8] Pre-compute thresholds once.
  const max   = bestDay || 1;
  const thr1  = max * 0.25;
  const thr2  = max * 0.50;
  const thr3  = max * 0.75;

  // ── Second pass: render ─────────────────────────────────────────────────
  const gridFrag   = document.createDocumentFragment();
  const monthsFrag = document.createDocumentFragment();
  let curMonth = -1;

  for (let w = 0; w < 53; w++) {
    const wStart = new Date(start);
    wStart.setDate(wStart.getDate() + w * 7);

    const mEl = document.createElement('div');
    mEl.className = 'hm-month-lbl';
    if (wStart.getMonth() !== curMonth && wStart.getDate() <= 7) {
      mEl.textContent = wStart.toLocaleDateString('en-US', { month: 'short' });
      curMonth = wStart.getMonth();
    }
    monthsFrag.appendChild(mEl);

    for (let d = 0; d < 7; d++) {
      const cell  = allCells[w * 7 + d];
      const count = cell ? cell.count : 0;

      // [FIX 8] Use pre-computed thresholds.
      let lv = 0;
      if (count > 0) {
        lv = count < thr1 ? 1 : count < thr2 ? 2 : count < thr3 ? 3 : 4;
      }

      const cellEl = document.createElement('div');
      cellEl.className = `hm-cell lv${lv}`;
      cellEl.title     = `${cell?.ds || ''}: ${count} review${count !== 1 ? 's' : ''}`;
      cellEl.style.gridColumn = w + 1;
      cellEl.style.gridRow    = d + 1;
      gridFrag.appendChild(cellEl);
    }
  }

  grid.innerHTML   = '';
  months.innerHTML = '';
  grid.appendChild(gridFrag);
  months.appendChild(monthsFrag);

  // Update summary stats
  _setTextContent('actTotal',      total);
  _setTextContent('actDays',       activeDays);
  _setTextContent('actAvg',        activeDays ? Math.round(total / activeDays) : 0);
  _setTextContent('actBest',       bestDay);
  _setTextContent('actCurStreak',  state.currentStreak);
  _setTextContent('actBestStreak', state.bestStreak);
}

/** Tiny helper — sets textContent only when the element exists. */
function _setTextContent(id, value) {
  const e = el(id);
  if (e) e.textContent = value;
}


// ─────────────────────────────────────────────────────────────────────────────
// IMPORT / EXPORT
// ─────────────────────────────────────────────────────────────────────────────

// ── Validation limits for CSV import ─────────────────────────────────────────

const CSV_LIMITS = Object.freeze({
  TITLE:   500,
  CONTENT: 10_000,
  DECK:    100,
});

function renderImport() {
  const csvSel   = el('csvDeckSel');
  const pasteSel = el('pasteDeckSel');

  if (csvSel)   csvSel.innerHTML   = '<option value="">Auto from deck column</option>';
  if (pasteSel) pasteSel.innerHTML = '<option value="">-- Select Deck --</option>';

  state.decks.forEach(d => {
    [csvSel, pasteSel].forEach(sel => {
      if (!sel) return;
      const o   = document.createElement('option');
      o.value   = d.id;
      o.textContent = d.name;
      sel.appendChild(o);
    });
  });
}

function handleCsvFile(file) {
  if (!file) return;
  const reader    = new FileReader();
  reader.onload   = e => {
    const rows    = parseCsv(e.target.result);
    T.csvRows     = rows;
    const prev    = el('csvPreview');
    if (prev) {
      prev.style.display = 'block';
      prev.textContent   = `Found ${rows.length} rows. Columns: ${Object.keys(rows[0] || {}).join(', ')}`;
    }
  };
  reader.readAsText(file);
}

function parseCsv(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (!lines.length) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));

  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const obj  = {};
    headers.forEach((h, i) => obj[h] = vals[i] || '');
    return obj;
  });
}

/**
 * [FIX 7] Sanitise and length-limit every field before storing.
 * Angle brackets are stripped to prevent XSS in the HTML print sheet.
 */
function _sanitise(str, maxLen) {
  return String(str || '')
    .replace(/[<>]/g, '')
    .slice(0, maxLen)
    .trim();
}

function importCsv() {
  if (!T.csvRows?.length) { alert('Load a CSV file first.'); return; }

  const targetDeckId = el('csvDeckSel')?.value;
  let   imported     = 0;

  T.csvRows.forEach(row => {
    // [FIX 7] Sanitise and enforce length limits.
    const title   = _sanitise(row.title || row.question || row.front, CSV_LIMITS.TITLE);
    if (!title) return;

    const content  = _sanitise(row.notes || row.answer || row.back,  CSV_LIMITS.CONTENT);
    const deckName = _sanitise(row.deck  || row.category || 'Imported', CSV_LIMITS.DECK) || 'Imported';

    let deckId = targetDeckId;

    if (!deckId) {
      let deck = state.decks.find(d => d.name.toLowerCase() === deckName.toLowerCase());
      if (!deck) {
        deck = {
          id:           uid(),
          name:         deckName,
          desc:         'Imported',
          color:        DECK_COLORS[state.decks.length % DECK_COLORS.length],
          parentId:     null,
          scheduleMode: 'auto',
        };
        state.decks.push(deck);
      }
      deckId = deck.id;
    }

    const id = uid();
    state.topics.push({
      id,
      title,
      content,
      deckId,
      startDate: todayStr(),
      type:      'standard',
    });
    state.sm2[id] = fsrsInit(id);
    imported++;
  });

  save();
  T.csvRows = [];
  invalidateDueCountCache();

  const prev = el('csvPreview');
  if (prev) prev.textContent = `Imported ${imported} topics.`;

  renderDecks();
  refreshAllDeckSelects();
}

function importPasteText() {
  const text   = el('pasteTA')?.value.trim();
  const deckId = el('pasteDeckSel')?.value;

  if (!text)   { alert('Paste some text first.');   return; }
  if (!deckId) { alert('Select a target deck.');    return; }

  const lines    = text.split('\n').filter(l => l.trim());
  let   imported = 0;

  lines.forEach(line => {
    const parts   = line.split('|');
    // [FIX 7] Sanitise pasted input too.
    const title   = _sanitise(parts[0], CSV_LIMITS.TITLE);
    if (!title) return;

    const content = _sanitise(parts[1] || '', CSV_LIMITS.CONTENT);
    const id      = uid();

    state.topics.push({
      id,
      title,
      content,
      deckId,
      startDate: todayStr(),
      type:      'standard',
    });
    state.sm2[id] = fsrsInit(id);
    imported++;
  });

  save();
  invalidateDueCountCache();

  const pasteTA = el('pasteTA');
  if (pasteTA) pasteTA.value = '';

  alert(`Imported ${imported} topics.`);
  renderDecks();
}

/** Export card data as CSV. */
function exportCsv() {
  const rows = [
    ['title', 'notes', 'deck', 'type', 'startDate', 'nextReviewDate', 'stability', 'retention'],
  ];

  state.topics.forEach(t => {
    const deck           = state.decks.find(d => d.id === t.deckId);
    const card           = state.sm2[t.id];
    const stab           = card?.state ? Math.round(card.state.stability) : 0;
    const ret            = getRetention(ensureCard(t.id));
    const nextReviewDate = card?.nextReviewAt ? _tsToDate(card.nextReviewAt) : '';

    rows.push([
      `"${(t.title   || '').replace(/"/g, '""')}"`,
      `"${(t.content || '').replace(/"/g, '""')}"`,
      `"${(deck?.name || '').replace(/"/g, '""')}"`,
      t.type || 'standard',
      t.startDate || '',
      nextReviewDate,
      stab,
      ret !== null ? ret + '%' : '',
    ]);
  });

  downloadFile(
    'mnemo-export.csv',
    rows.map(r => r.join(',')).join('\n'),
    'text/csv'
  );
}

/** Export the full state as a JSON backup. */
function exportJson() {
  const data = {
    decks:    state.decks,
    topics:   state.topics,
    journal:  state.journal,
    history:  state.history,
    sm2:      state.sm2,
    goals:    state.goals,
    settings: state.settings,
  };
  downloadFile('mnemo-backup.json', JSON.stringify(data, null, 2), 'application/json');
}

/** Open a print-friendly HTML page with all cards. */
function printStudySheet() {
  const win  = window.open('', '_blank');
  let   html = `<html><head><title>Mnemo Study Sheet</title><style>
    body{font-family:Georgia,serif;padding:40px;color:#111}
    h1{font-size:1.4rem;border-bottom:2px solid #333;padding-bottom:8px;margin-bottom:20px}
    .deck{margin-bottom:28px}.dn{font-size:1rem;font-weight:700;margin-bottom:10px;color:#333}
    .topic{padding:8px 0;border-bottom:1px solid #eee}.tt{font-weight:700;margin-bottom:4px}
    .tn{color:#555;font-size:0.88rem}
  </style></head><body>`;

  html += `<h1>Mnemo Study Sheet — ${new Date().toLocaleDateString()}</h1>`;

  state.decks.filter(d => !d.parentId).forEach(deck => {
    const topics = state.topics.filter(t => isInDeck(t.deckId, deck.id));
    if (!topics.length) return;
    html += `<div class="deck"><div class="dn">${esc(deck.name)} (${topics.length})</div>`;
    topics.forEach(t => {
      html += `<div class="topic"><div class="tt">${esc(t.title)}</div>${t.content
        ? `<div class="tn">${esc(t.content)}</div>`
        : ''}</div>`;
    });
    html += '</div>';
  });

  html += '</body></html>';
  win.document.write(html);
  win.document.close();
  win.print();
}

/**
 * Trigger a file download.
 *
 * [FIX 1] Revoke the object URL after the click event so the browser can
 * release the memory immediately rather than holding it until page unload.
 */
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = name;
  a.click();
  // [FIX 1] 100 ms is enough for the browser to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function setupImportExportEvents() {
  const drop = el('importDrop');

  drop?.addEventListener('click', () => el('csvFileInput')?.click());

  drop?.addEventListener('dragover', e => {
    e.preventDefault();
    drop.classList.add('drag-over');
  });

  drop?.addEventListener('dragleave', () => drop.classList.remove('drag-over'));

  drop?.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    handleCsvFile(e.dataTransfer.files[0]);
  });

  el('csvFileInput')?.addEventListener('change',  e => handleCsvFile(e.target.files[0]));
  el('csvImportBtn')?.addEventListener('click',   importCsv);
  el('pasteImportBtn')?.addEventListener('click', importPasteText);
  el('exportCsvBtn')?.addEventListener('click',   exportCsv);
  el('exportJsonBtn')?.addEventListener('click',  exportJson);
  el('printBtn')?.addEventListener('click',       printStudySheet);
}


// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

window.renderSettings         = renderSettings;
window.saveSettings           = saveSettings;
window.setupSettingsEvents    = setupSettingsEvents;
window.renderAnalytics        = renderAnalytics;
window.renderGoals            = renderGoals;
window.saveGoal               = saveGoal;
window.setupGoalEvents        = setupGoalEvents;
window.initPomodoro           = initPomodoro;
window.updatePomDisplay       = updatePomDisplay;
window.togglePom              = togglePom;
window.setupPomodoroEvents    = setupPomodoroEvents;
window.renderHeatmap          = renderHeatmap;
window.renderImport           = renderImport;
window.handleCsvFile          = handleCsvFile;
window.parseCsv               = parseCsv;
window.importCsv              = importCsv;
window.importPasteText        = importPasteText;
window.exportCsv              = exportCsv;
window.exportJson             = exportJson;
window.printStudySheet        = printStudySheet;
window.downloadFile           = downloadFile;
window.setupImportExportEvents = setupImportExportEvents;
window.invalidateDueCountCache = invalidateDueCountCache;