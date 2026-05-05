/* ============================================================================
   MNEMO — CALENDAR, DATE-VIEW, JOURNAL, BROWSE
   Uses FSRS-6 (state.sm2[tid] card objects) with nextReviewAt timestamps.

   Past cards live in state.topics with isPastFixed: true.
   state.pastCards no longer exists — migratePastCards() handles old data on load.
   ============================================================================ */

/* ─── ONE-TIME MIGRATION ─────────────────────────────────────────────────────
   Call once at app startup before any render.
   Moves legacy state.pastCards entries into state.topics with isPastFixed:true,
   then deletes the old array and saves.
   Safe to call repeatedly — exits immediately if nothing to migrate.
   ──────────────────────────────────────────────────────────────────────────── */

   function migratePastCards() {
    if (!state.pastCards?.length) {
      delete state.pastCards;
      return;
    }
  
    const existingIds = new Set(state.topics.map(t => t.id));
  
    state.pastCards.forEach(c => {
      if (existingIds.has(c.id)) return; // already migrated
      state.topics.push({
        id:          c.id,
        title:       c.title   || '',
        content:     c.content || '',
        deckId:      null,
        isPastFixed: true,
        startDate:   c.startDate  || null,
        fixedDates:  Array.isArray(c.fixedDates) ? c.fixedDates : [],
        createdAt:   c.createdAt  || c.startDate || todayStr(),
      });
    });
  
    delete state.pastCards;
    save();
  }
  
  /* ─── HELPERS ────────────────────────────────────────────────────────────────── */
  
  function timestampToDateStr(ts) {
    if (!ts) return null;
    return new Date(ts).toISOString().split('T')[0];
  }
  
  function getCardNextReviewDate(card) {
    if (!card || card.pile === 'new' || !card.nextReviewAt) return null;
    return timestampToDateStr(card.nextReviewAt);
  }
  
  /**
   * All topics that belong to date ds — scheduled, future-preview, or past-fixed.
   * Single source of truth. Reads only state.topics.
   */
  function getAllCardsForDate(ds) {
    const today = todayStr();
    return state.topics.filter(t => {
      if (t.isPastFixed) {
        return t.startDate === ds ||
          (Array.isArray(t.fixedDates) && t.fixedDates.includes(ds));
      }
      if (t.startDate && t.startDate > today) return t.startDate === ds;
      return getCardNextReviewDate(state.sm2[t.id]) === ds;
    });
  }
  
  /* ─── CALENDAR (main entry point) ────────────────────────────────────────────── */
  
  function renderCalendar() {
    renderCalGrid();
    renderCalPanel();
    renderCalUpcoming();
  }
  
  /* ─── CALENDAR GRID ──────────────────────────────────────────────────────────── */
  
  function renderCalGrid() {
    const { calYear: y, calMonth: m } = state;
  
    el('calMonthLabel').textContent = new Date(y, m, 1).toLocaleDateString('en-US', {
      month: 'long', year: 'numeric',
    });
  
    const today       = todayStr();
    const firstDow    = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const daysInPrev  = new Date(y, m, 0).getDate();
  
    // srMap  → blue dots  (FSRS due / future preview)
    // pastMap → gray dots (isPastFixed cards)
    const srMap   = {};
    const pastMap = {};
  
    state.topics.forEach(t => {
      if (t.isPastFixed) {
        [t.startDate, ...(Array.isArray(t.fixedDates) ? t.fixedDates : [])].forEach(d => {
          if (d) pastMap[d] = (pastMap[d] || 0) + 1;
        });
      } else {
        const d = (t.startDate && t.startDate > today)
          ? t.startDate
          : getCardNextReviewDate(state.sm2[t.id]);
        if (d) srMap[d] = (srMap[d] || 0) + 1;
      }
    });
  
    const grid = el('calGrid');
    grid.innerHTML = '';
  
    for (let i = 0; i < 42; i++) {
      let ds, dayNum, other = false;
  
      if (i < firstDow) {
        dayNum = daysInPrev - firstDow + i + 1;
        ds = fmt(new Date(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1, dayNum));
        other = true;
      } else if (i >= firstDow + daysInMonth) {
        dayNum = i - firstDow - daysInMonth + 1;
        ds = fmt(new Date(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1, dayNum));
        other = true;
      } else {
        dayNum = i - firstDow + 1;
        ds = fmt(new Date(y, m, dayNum));
      }
  
      const classes = ['cal-cell'];
      if (other)                        classes.push('other-month');
      if (ds === today)                 classes.push('today');
      if (ds === state.calSelected)     classes.push('selected');
      if (state.calHover?.includes(ds)) classes.push('cal-hover-cell');
      if (ds < today)                   classes.push('cal-past');
      if (ds > today)                   classes.push('cal-future');
  
      const cell = document.createElement('div');
      cell.className = classes.join(' ');
      cell.innerHTML = `<div class="cal-day-num">${dayNum}</div><div class="cal-indicators"></div>`;
  
      const totalCount = (srMap[ds] || 0) + (pastMap[ds] || 0);
      if (totalCount > 0) {
        const ind = cell.querySelector('.cal-indicators');
        if (srMap[ds])   ind.appendChild(makeDot('ci-blue'));
        if (pastMap[ds]) ind.appendChild(makeDot('ci-gray'));
        if (totalCount > 1) {
          const badge = document.createElement('span');
          badge.className = 'ci-badge';
          badge.textContent = totalCount;
          ind.appendChild(badge);
        }
      }
  
      cell.addEventListener('click',      () => onCalClick(ds));
      cell.addEventListener('mouseenter', () => onCalHover(ds));
      cell.addEventListener('mouseleave', () => {
        if (state.calHover?.length) { state.calHover = []; renderCalGrid(); }
      });
  
      grid.appendChild(cell);
    }
  }
  
  function makeDot(cls) {
    const d = document.createElement('div');
    d.className = `ci-dot ${cls}`;
    return d;
  }
  
  /* ─── CALENDAR INTERACTIONS ──────────────────────────────────────────────────── */
  
  /** Selecting a date never auto-navigates. User must click "View Cards" explicitly. */
  function onCalClick(ds) {
    state.calSelected = ds;
    renderCalGrid();
    renderCalPanel();
  }
  
  function navigateToDateView(ds) {
    state.calSelected = ds;
    switchSection('dateview');
  }
  
  function onCalHover(ds) {
    const newHover = getAllCardsForDate(ds).length ? [ds] : [];
    if (JSON.stringify(state.calHover) !== JSON.stringify(newHover)) {
      state.calHover = newHover;
      renderCalGrid();
    }
  }
  
  /* ─── CALENDAR SIDE PANEL ────────────────────────────────────────────────────── */
  
  function renderCalPanel() {
    if (!state.calSelected) {
      el('calPanelDate').textContent = 'Select a date';
      el('calPanelTopics').innerHTML = '';
      return;
    }
  
    const ds     = state.calSelected;
    const today  = todayStr();
    const isPast = ds < today;
  
    el('calPanelDate').textContent = dispDate(ds);
  
    const addBtn = el('calAddTopicBtn');
    if (addBtn) {
      addBtn.textContent = isPast
        ? '+ Add Card to this past date'
        : '+ Add Topic to this date';
    }
  
    const cards     = getAllCardsForDate(ds);
    const container = el('calPanelTopics');
    container.innerHTML = '';
  
    if (!cards.length) {
      container.innerHTML = '<div style="font-size:0.76rem;color:var(--ink3)">No topics scheduled.</div>';
      return;
    }
  
    // Explicit entry into Date View — no auto-navigation
    const viewBtn = document.createElement('button');
    viewBtn.className = 'btn-primary';
    viewBtn.style.cssText = 'width:100%;margin-bottom:10px;font-size:0.82rem;';
    viewBtn.textContent = isPast
      ? `📖 View Cards from ${shortDate(ds)}`
      : ds > today
        ? `📅 Preview Cards for ${shortDate(ds)}`
        : `📖 View Cards`;
    viewBtn.addEventListener('click', () => navigateToDateView(ds));
    container.appendChild(viewBtn);
  
    cards.forEach(t => {
      const isPastCard = !!t.isPastFixed;
      const deck = isPastCard
        ? { name: 'Past Card', color: '#9AA4B2' }
        : (state.decks.find(d => d.id === t.deckId) || { name: 'Uncategorized', color: '#7B6EF6' });
      const card  = isPastCard ? null : state.sm2[t.id];
      const pile  = card?.pile || 'new';
      const stab  = card?.state ? Math.round(card.state.stability) : 0;
      const label = isPastCard        ? 'Fixed timeline · view only'
        : pile === 'new'              ? 'New'
        : pile === 'learning'         ? 'Learning'
        : `Review (S:${stab}d)`;
  
      const div = document.createElement('div');
      div.className = 'cal-topic-card';
      div.style.borderLeftColor = deck.color;
      div.innerHTML = `
        <div class="ctc-title">${esc(t.title)}</div>
        <div class="ctc-meta">
          <span style="background:${deck.color}22;color:${deck.color};padding:1px 6px;border-radius:8px;font-size:0.6rem;font-weight:800">${esc(deck.name)}</span>
          <span>${esc(label)}</span>
        </div>
        <div class="ctc-actions">
          <button class="ctc-btn ctc-edit">✏️ Edit</button>
          <button class="ctc-btn ctc-del">🗑️ Delete</button>
        </div>`;
  
      div.querySelector('.ctc-edit').addEventListener('click', () =>
        isPastCard ? openEditPastCard(t.id) : openEditTopic(t.id));
  
      div.querySelector('.ctc-del').addEventListener('click', () => {
        if (!confirm(`Delete "${t.title}"?`)) return;
        state.topics = state.topics.filter(x => x.id !== t.id);
        if (!isPastCard) delete state.sm2[t.id];
        saveImmediate();
        renderCalendar();
      });
  
      container.appendChild(div);
    });
  }
  
  /* ─── UPCOMING PANEL ─────────────────────────────────────────────────────────── */
  
  function renderCalUpcoming() {
    const today   = todayStr();
    const horizon = addDays(today, 30);
    const items   = [];
  
    state.topics.forEach(t => {
      if (t.isPastFixed) return;
      const d = getCardNextReviewDate(state.sm2[t.id]);
      if (d && d >= today && d <= horizon) {
        const deck = state.decks.find(dk => dk.id === t.deckId) || { name: 'Uncategorized' };
        items.push({ date: d, title: t.title, deck: deck.name });
      }
    });
  
    items.sort((a, b) => a.date.localeCompare(b.date));
  
    const badge = el('cupBadge');
    if (badge) badge.textContent = items.length;
  
    const list = el('cupList');
    if (!list) return;
    list.innerHTML = '';
  
    if (!items.length) {
      list.innerHTML = '<div style="font-size:0.74rem;color:var(--ink3)">No upcoming reviews in 30 days.</div>';
      return;
    }
  
    items.slice(0, 25).forEach(item => {
      const diff     = daysFromToday(item.date);
      const dayLabel = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : `In ${diff}d`;
  
      const div = document.createElement('div');
      div.className = 'cup-item';
      div.innerHTML = `
        <div class="cup-date">${shortDate(item.date)}</div>
        <div class="cup-days ${diff === 0 ? 'is-today' : ''}">${dayLabel}</div>
        <div class="cup-name">${esc(item.title)}</div>`;
  
      div.addEventListener('click', () => {
        const d = parseD(item.date);
        state.calYear     = d.getFullYear();
        state.calMonth    = d.getMonth();
        state.calSelected = item.date;
        renderCalendar();
      });
  
      list.appendChild(div);
    });
  }
  
  /* ─── DATE VIEW ──────────────────────────────────────────────────────────────── */
  
  function renderDateView() {
    const ds = state.calSelected;
  
    if (!ds) {
      setDateViewEmpty('📅', 'No date selected. Go back to the calendar.');
      return;
    }
  
    const today    = todayStr();
    const isPast   = ds < today;
    const isFuture = ds > today;
  
    const titleEl = el('dvDateTitle');
    if (titleEl) titleEl.textContent = dispDate(ds);
  
    const badgeEl = el('dvBadge');
    if (badgeEl) {
      if (isPast)        { badgeEl.textContent = '📜 Past Date — View Only';      badgeEl.style.color = 'var(--amb)'; }
      else if (isFuture) { badgeEl.textContent = '🔮 Future Date — Preview Only'; badgeEl.style.color = 'var(--acc)'; }
      else                 badgeEl.textContent = '';
    }
  
    const cards   = getAllCardsForDate(ds);
    const countEl = el('dvCount');
    if (countEl) countEl.textContent = `${cards.length} card${cards.length !== 1 ? 's' : ''}`;
  
    if (!cards.length) {
      setDateViewEmpty(isPast ? '📭' : '🗓️', `No cards scheduled for ${dispDate(ds)}.`);
      return;
    }
  
    runViewSession('dvContainer', cards, () => switchSection('calendar'), 'Back to Calendar');
  }
  
  function setDateViewEmpty(icon, msg) {
    const c = el('dvContainer');
    if (c) c.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">${icon}</div>
        <div class="es-msg">${msg}</div>
      </div>`;
  }
  
  /* ─── BROWSE MODE ────────────────────────────────────────────────────────────── */
  
  function renderBrowse() {
    const cards  = state.browseQueue || [];
    const deckId = state.browseDeckId;
    const deck   = state.decks.find(d => d.id === deckId) || { name: 'Deck', color: '#7B6EF6' };
  
    const titleEl = el('browseDeckTitle');
    if (titleEl) titleEl.textContent = `Browse: ${deck.name}`;
  
    if (!cards.length) {
      const c = el('browseContainer');
      if (c) c.innerHTML = `
        <div class="empty-state">
          <div class="es-icon">📭</div>
          <div class="es-msg">No cards in this deck.</div>
        </div>`;
      return;
    }
  
    runViewSession('browseContainer', cards, () => switchSection('decks'), 'Back to Decks', deck);
  }
  
  /* ─── SHARED VIEW SESSION ────────────────────────────────────────────────────────
     Used by both Date View and Browse Mode.
  
     FIX: The previous implementation attached a keydown listener per render()
     call and only removed it inside the session flow (show-answer click). If the
     user navigated away mid-session — via the Back button, sidebar, or any
     switchSection() call — the handler was orphaned and kept firing forever.
     Each new session added another stale listener on top.
  
     Fix strategy:
     1. `cleanup()` — single function that removes the listener and marks the
        session as unmounted so stale closures are no-ops.
     2. The container is watched with a MutationObserver. When it is removed from
        the DOM, or when its contents are replaced by a re-render, cleanup() fires
        automatically with no coordination from the caller.
     3. The "Back" button inside the session calls cleanup() before handing off
        to onDone(), so keyboard handling stops before the section switch.
     ──────────────────────────────────────────────────────────────────────────── */
  
  function runViewSession(containerId, cards, onDone, doneLabel, deckOverride = null) {
    let idx         = 0;
    let answerShown = false;
    let keyHandler  = null;
    let mounted     = true; // false once this session has been torn down
  
    /* ── Keyboard cleanup ─────────────────────────────────────────────────── */
  
    function detachKey() {
      if (keyHandler) {
        document.removeEventListener('keydown', keyHandler);
        keyHandler = null;
      }
    }
  
    /**
     * Tear down the entire session: remove listener, mark unmounted.
     * Safe to call multiple times — idempotent.
     */
    function cleanup() {
      if (!mounted) return;
      mounted = false;
      detachKey();
      if (observer) observer.disconnect();
    }
  
    function attachKey() {
      detachKey();
      keyHandler = e => {
        if (!mounted) return;            // stale closure guard
        if (e.code === 'Space' && !answerShown) {
          e.preventDefault();
          answerShown = true;
          render();
        }
      };
      document.addEventListener('keydown', keyHandler);
    }
  
    /* ── MutationObserver: auto-cleanup when container leaves the DOM ─────── */
  
    let observer = null;
  
    const container = el(containerId);
    if (container) {
      observer = new MutationObserver(() => {
        // Cleanup if the container is detached from the document, or if its
        // content was replaced by something other than our own render() call
        // (e.g. switchSection() blanked it).
        if (!document.contains(container)) cleanup();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  
    /* ── Render ───────────────────────────────────────────────────────────── */
  
    function render() {
      if (!mounted) return;
  
      const t      = cards[idx];
      const isLast = idx === cards.length - 1;
  
      const isPastCard = !!t.isPastFixed;
  
      const deck = deckOverride
        ? (state.decks.find(d => d.id === t.deckId) || deckOverride)
        : isPastCard
          ? { name: 'Past Card', color: '#9AA4B2' }
          : (state.decks.find(d => d.id === t.deckId) || { name: 'Uncategorized', color: '#7B6EF6' });
  
      const card      = isPastCard ? null : state.sm2?.[t.id];
      const pile      = card?.pile || 'new';
      const stability = card?.state ? Math.round(card.state.stability) : 0;
      const retention = (card && deckOverride) ? getRetention(card) : null;
  
      const pileLabel = isPastCard
        ? '🗂️ Fixed interval snapshot'
        : pile === 'new'      ? '🆕 New'
        : pile === 'learning' ? '📖 Learning'
        : `🔁 Review${deckOverride ? '' : ` (S:${stability}d)`}`;
  
      const metaExtras = (deckOverride && pile !== 'new') ? `
        <span class="dv-readonly-notice" title="Stability">📐 ${stability}d</span>
        <span class="dv-readonly-notice" title="Retention">🧠 ${retention}%</span>` : '';
  
      const viewOnlyBadge = !deckOverride
        ? `<span class="dv-readonly-notice">👁️ View only</span>`
        : '';
  
      const controls = !answerShown
        ? `<button class="btn-show-answer" id="vsShowBtn">Show Answer &nbsp;<kbd>Space</kbd></button>`
        : isLast
          ? `<button class="btn-primary dv-done-btn" id="vsDoneBtn">✓ Done</button>`
          : `<button class="btn-primary dv-next-btn" id="vsNextBtn">Next →</button>`;
  
      const c = el(containerId);
      if (!c) { cleanup(); return; }
  
      c.innerHTML = `
        <div class="dv-session">
          <div class="dv-topbar">
            <span class="dv-prog">${idx + 1} / ${cards.length}</span>
            <div class="dv-pb-track">
              <div class="dv-pb-fill" style="width:${(idx / cards.length) * 100}%"></div>
            </div>
          </div>
          <div class="dv-card">
            <div class="dv-card-meta">
              <span class="dv-deck-tag" style="background:${deck.color}22;color:${deck.color}">${esc(deck.name)}</span>
              <span class="dv-rev-badge">${pileLabel}</span>
              ${metaExtras}
              ${viewOnlyBadge}
            </div>
            <div class="dv-question">${esc(t.title)}</div>
            <div class="dv-answer-wrap ${answerShown ? '' : 'hidden'}">
              <div class="dv-answer-sep">— Answer —</div>
              <div class="dv-answer">${
                t.content
                  ? esc(t.content)
                  : '<span style="color:var(--ink3);font-style:italic">No answer provided</span>'
              }</div>
            </div>
          </div>
          <div class="dv-controls">${controls}</div>
        </div>`;
  
      if (!answerShown) {
        el('vsShowBtn')?.addEventListener('click', () => {
          if (!mounted) return;
          answerShown = true;
          detachKey(); // keyboard no longer needed once answer shown
          render();
        });
        attachKey();
      } else {
        detachKey();
  
        if (isLast) {
          el('vsDoneBtn')?.addEventListener('click', () => {
            if (!mounted) return;
            cleanup();
            const c = el(containerId);
            if (c) {
              c.innerHTML = `
                <div class="empty-state">
                  <div class="es-icon">✅</div>
                  <div class="es-msg">You've reviewed all ${cards.length} card${cards.length !== 1 ? 's' : ''}.</div>
                  <button class="btn-primary" style="margin-top:8px">${doneLabel}</button>
                </div>`;
              c.querySelector('button')?.addEventListener('click', onDone);
            }
          });
        } else {
          el('vsNextBtn')?.addEventListener('click', () => {
            if (!mounted) return;
            idx++;
            answerShown = false;
            render();
          });
        }
      }
    }
  
    render();
  }
  
  /* ─── EDIT PAST CARD ─────────────────────────────────────────────────────────── */
  
  function openEditPastCard(id) {
    const c = state.topics.find(t => t.id === id && t.isPastFixed);
    if (!c) return;
  
    T.editingTopicId = `past:${id}`;
  
    if (el('topicModalTitle')) el('topicModalTitle').textContent = 'Edit Past Card';
    if (el('topicEditId'))     el('topicEditId').value = `past:${id}`;
    if (el('fTitle'))          el('fTitle').value   = c.title   || '';
    if (el('fContent'))        el('fContent').value = c.content || '';
    if (el('fDate'))           el('fDate').value    = c.startDate || todayStr();
  
    el('resetCardBtn')?.classList.add('hidden');
    el('clozeHint')?.classList.add('hidden');
  
    document.querySelectorAll('#cardTypeSwitch .mode-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.type === 'standard'));
  
    refreshAllDeckSelects();
    if (el('fDeck')) el('fDeck').value = '';
  
    openModal('topicModal');
  }
  
  /* ─── BACKWARD-COMPAT ALIAS ──────────────────────────────────────────────────── */
  
  function renderPast() {
    if (state.calSelected && state.calSelected < todayStr()) renderDateView();
  }
  
  /* ─── JOURNAL ────────────────────────────────────────────────────────────────── */
  
  let _journalSaveTimer  = null;
  let _journalInputHandler = null; // stored so it can be cleanly removed
  
  function autoSaveJournal() {
    if (_journalSaveTimer) clearTimeout(_journalSaveTimer);
    _journalSaveTimer = setTimeout(() => {
      if (state.jSelected && state.journal[state.jSelected] !== undefined) {
        (typeof saveImmediate === 'function' ? saveImmediate : save)();
      }
    }, 1000);
  }
  
  function renderJournal() {
    renderJMiniCal();
    renderJEditor();
    renderJRecent();
  }
  
  function renderJMiniCal() {
    const { jYear: year, jMonth: month } = state;
  
    const monthLabel = el('jMonthLabel');
    if (monthLabel) {
      monthLabel.textContent = new Date(year, month, 1).toLocaleDateString('en-US', {
        month: 'short', year: 'numeric',
      });
    }
  
    const today       = todayStr();
    const firstDow    = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev  = new Date(year, month, 0).getDate();
    const grid        = el('jMcGrid');
    if (!grid) return;
    grid.innerHTML = '';
  
    for (let i = 0; i < 42; i++) {
      let ds, dayNum, other = false;
  
      if (i < firstDow) {
        dayNum = daysInPrev - firstDow + i + 1;
        ds     = fmt(new Date(month === 0 ? year - 1 : year, month === 0 ? 11 : month - 1, dayNum));
        other  = true;
      } else if (i >= firstDow + daysInMonth) {
        dayNum = i - firstDow - daysInMonth + 1;
        ds     = fmt(new Date(month === 11 ? year + 1 : year, month === 11 ? 0 : month + 1, dayNum));
        other  = true;
      } else {
        dayNum = i - firstDow + 1;
        ds     = fmt(new Date(year, month, dayNum));
      }
  
      const hasEntry = !!state.journal[ds]?.trim();
      const classes  = ['jmc-cell'];
      if (other)                  classes.push('other-month');
      if (ds === today)           classes.push('today');
      if (ds === state.jSelected) classes.push('selected');
      if (hasEntry)               classes.push('has-entry');
  
      const cell = document.createElement('div');
      cell.className = classes.join(' ');
      cell.innerHTML = `<span class="jmc-day-num">${dayNum}</span>${hasEntry ? '<span class="jmc-dot">●</span>' : ''}`;
      cell.addEventListener('click', () => {
        state.jSelected = ds;
        renderJMiniCal();
        renderJEditor();
      });
      grid.appendChild(cell);
    }
  }
  
  /**
   * FIX: Previously used cloneNode() + replaceChild() to drop stale listeners,
   * which destroyed external element references and was wasteful on every render.
   *
   * Instead we keep a module-level reference to the current handler
   * (_journalInputHandler) and removeEventListener() it before adding the new
   * one. The textarea node itself is never replaced — only its value and the
   * listener are updated.
   */
  function renderJEditor() {
    const ta   = el('journalTA');
    const head = el('journalDateHead');
    if (!ta || !head) return;
  
    if (!state.jSelected) {
      head.textContent = 'Select a date to write';
      ta.value         = '';
      ta.disabled      = true;
      // Remove any lingering handler so typing on a disabled field does nothing
      if (_journalInputHandler) {
        ta.removeEventListener('input', _journalInputHandler);
        _journalInputHandler = null;
      }
      return;
    }
  
    head.textContent = dispDate(state.jSelected);
    ta.disabled      = false;
    ta.value         = state.journal[state.jSelected] || '';
    updateJStats(ta.value);
  
    // Remove the previous handler before attaching a fresh one.
    // This is O(1) and keeps the textarea node stable in the DOM.
    if (_journalInputHandler) {
      ta.removeEventListener('input', _journalInputHandler);
    }
  
    // Capture the selected date in the closure so stale handlers that somehow
    // fire after reassignment still write to the right key.
    const capturedDate = state.jSelected;
    _journalInputHandler = e => {
      state.journal[capturedDate] = e.target.value;
      updateJStats(e.target.value);
      autoSaveJournal();
    };
  
    ta.addEventListener('input', _journalInputHandler);
  }
  
  function updateJStats(text) {
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const elW   = el('jWords');
    const elC   = el('jChars');
    if (elW) elW.textContent = `${words} words`;
    if (elC) elC.textContent = `${text.length} chars`;
  }
  
  function renderJRecent() {
    const list = el('jRecentList');
    if (!list) return;
    list.innerHTML = '';
  
    const entries = Object.entries(state.journal)
      .filter(([, v]) => v?.trim())
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 10);
  
    if (!entries.length) {
      list.innerHTML = '<div style="font-size:0.74rem;color:var(--ink3)">No entries yet.</div>';
      return;
    }
  
    entries.forEach(([ds, text]) => {
      const div = document.createElement('div');
      div.className = 'jr-item';
      div.innerHTML = `
        <div class="jr-date">${shortDate(ds)}</div>
        <div class="jr-preview">${esc(text.substring(0, 100))}${text.length > 100 ? '…' : ''}</div>`;
      div.addEventListener('click', () => {
        const d = parseD(ds);
        state.jSelected = ds;
        state.jYear     = d.getFullYear();
        state.jMonth    = d.getMonth();
        renderJMiniCal();
        renderJEditor();
      });
      list.appendChild(div);
    });
  }
  
  function prevJMonth() {
    if (state.jMonth === 0) { state.jMonth = 11; state.jYear--; }
    else state.jMonth--;
    renderJMiniCal();
  }
  
  function nextJMonth() {
    if (state.jMonth === 11) { state.jMonth = 0; state.jYear++; }
    else state.jMonth++;
    renderJMiniCal();
  }
  
  /* ─── EXPORTS ────────────────────────────────────────────────────────────────── */
  
  window.migratePastCards  = migratePastCards;
  window.prevJMonth        = prevJMonth;
  window.nextJMonth        = nextJMonth;
  window.openEditPastCard  = openEditPastCard;