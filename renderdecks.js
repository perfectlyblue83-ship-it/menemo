'use strict';

// ─── NAV STACK INIT ──────────────────────────────────────────────────────────

if (typeof window.T === 'undefined') window.T = {};
if (!Array.isArray(window.T.deckNavStack)) window.T.deckNavStack = [];

// ─── DRAG-TO-REORDER ─────────────────────────────────────────────────────────
//
// Long-press (LP_MS) on the ⠿ handle activates drag. Works with both mouse
// and touch via the Pointer Events API. Reordering is scoped to siblings that
// share the same data-parent-key, so deck rows cannot accidentally be dropped
// inside the children of another deck.

const _dr = {
  active:     false,
  type:       null,   // 'deck' | 'topic'
  id:         null,
  parentKey:  null,
  el:         null,   // source .tree-row
  ghost:      null,   // floating clone
  ph:         null,   // placeholder indicator bar
  timer:      null,
  startX:     0,
  startY:     0,
};
const LP_MS = 480;

// WeakSet so the pointerdown listener is added only once per container element
const _dragAttached = new WeakSet();

function _injectDragCSS() {
  if (document.getElementById('_drCSS')) return;
  const s = document.createElement('style');
  s.id = '_drCSS';
  s.textContent = `
    .drag-handle {
      cursor: grab; padding: 0 7px; color: var(--txt3, #9ca3af);
      user-select: none; touch-action: none; flex-shrink: 0; opacity: .4;
      display: flex; flex-direction: column; gap: 2.5px; justify-content: center;
      align-self: center;
    }
    .drag-handle:hover { opacity: 1; cursor: grab; }
    .drag-handle:active { cursor: grabbing; }
    .dh-r { display: flex; gap: 3px; }
    .dh-d { width: 3px; height: 3px; border-radius: 50%; background: currentColor; display: block; flex-shrink: 0; }
    .tree-row.is-inbox .drag-handle { visibility: hidden; pointer-events: none; }
    .tree-row.is-dragging { opacity: .25; pointer-events: none; }
    .drag-ghost {
      position: fixed; pointer-events: none; z-index: 9999;
      opacity: .9; border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,.35);
      background: var(--bg2, #1e293b);
    }
    .drag-placeholder {
      height: 3px; background: var(--acc, #6366f1);
      border-radius: 2px; margin: 1px 0;
      pointer-events: none; transition: none;
    }
    details.adv-section > summary {
      cursor: pointer; font-size: .83em;
      color: var(--txt2, #94a3b8);
      list-style: none; user-select: none;
      padding: 6px 0; display: flex; align-items: center; gap: 5px;
    }
    details.adv-section > summary::-webkit-details-marker { display: none; }
    details.adv-section > summary::before {
      content: '▸'; font-size: .75em; transition: transform .15s;
    }
    details.adv-section[open] > summary::before { content: '▾'; }
    details.adv-section > .adv-body { padding-top: 4px; }
  `;
  document.head.appendChild(s);
}

// ── Attach long-press drag to a container (idempotent) ───────────────────────

function _attachDragToContainer(container) {
  if (_dragAttached.has(container)) return;
  _dragAttached.add(container);
  container.addEventListener('pointerdown', _onDragPointerDown);
}

function _onDragPointerDown(e) {
  const handle = e.target.closest('.drag-handle');
  if (!handle) return;
  const row = handle.closest('.tree-row');
  if (!row) return;

  e.preventDefault();
  const sx = e.clientX, sy = e.clientY;

  _dr.timer = setTimeout(() => _drActivate(row, e), LP_MS);

  // Cancel if pointer moves too far before long-press fires
  function onMove(me) {
    if (Math.hypot(me.clientX - sx, me.clientY - sy) > 8) {
      clearTimeout(_dr.timer);
      document.removeEventListener('pointermove', onMove);
    }
  }
  function onUp() {
    clearTimeout(_dr.timer);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function _drActivate(row, e) {
  if (_dr.active) return;
  _dr.active    = true;
  _dr.type      = row.dataset.type;
  _dr.id        = _dr.type === 'deck' ? row.dataset.deckId : row.dataset.topicId;
  _dr.parentKey = row.dataset.parentKey || '';
  _dr.el        = row;

  row.classList.add('is-dragging');

  // Ghost clone that follows the pointer
  _dr.ghost = row.cloneNode(true);
  _dr.ghost.classList.add('drag-ghost');
  _dr.ghost.classList.remove('is-dragging');
  const rect = row.getBoundingClientRect();
  _dr.ghost.style.width   = rect.width  + 'px';
  _dr.ghost.style.left    = rect.left   + 'px';
  _dr.ghost.style.top     = rect.top    + 'px';
  document.body.appendChild(_dr.ghost);

  // Placeholder bar inserted before the source row
  _dr.ph = document.createElement('div');
  _dr.ph.className = 'drag-placeholder';
  row.parentNode.insertBefore(_dr.ph, row);

  document.addEventListener('pointermove', _drMove,   { passive: false });
  document.addEventListener('pointerup',   _drCommit);
  document.addEventListener('pointercancel', _drCancel);
}

function _drMove(e) {
  if (!_dr.active) return;
  e.preventDefault();

  // Move ghost
  _dr.ghost.style.left = (e.clientX - 20) + 'px';
  _dr.ghost.style.top  = (e.clientY - 20) + 'px';

  // Temporarily hide ghost so elementFromPoint can see through it
  _dr.ghost.style.visibility = 'hidden';
  const target = document.elementFromPoint(e.clientX, e.clientY);
  _dr.ghost.style.visibility = '';

  const targetRow = target?.closest('.tree-row:not(.is-dragging)');
  if (targetRow && targetRow.dataset.parentKey === _dr.parentKey) {
    const mid = targetRow.getBoundingClientRect().top
              + targetRow.getBoundingClientRect().height / 2;
    if (e.clientY < mid) {
      targetRow.parentNode.insertBefore(_dr.ph, targetRow);
    } else {
      targetRow.parentNode.insertBefore(_dr.ph, targetRow.nextSibling);
    }
  }
}

function _drCommit() {
  if (!_dr.active) return;
  _drCleanListeners();

  const ph = _dr.ph;
  if (ph && ph.parentNode) {
    // Collect all sibling rows with the same parentKey (in document order)
    const container = ph.closest('[id]') || document.body;
    const key = CSS.escape(_dr.parentKey);
    const siblingRows = [...container.querySelectorAll(
      `.tree-row[data-parent-key="${key}"]`
    )].filter(r => !r.classList.contains('is-dragging'));

    // Build ordered list: use document position of each sibling vs placeholder
    const allDesc = [...container.querySelectorAll('*')];
    const phPos   = allDesc.indexOf(ph);

    const withPos = siblingRows.map(r => ({
      id:   r.dataset.type === 'deck' ? r.dataset.deckId : r.dataset.topicId,
      type: r.dataset.type,
      pos:  allDesc.indexOf(r),
    }));

    // Insert dragged item at placeholder position
    const insertAt = withPos.findIndex(s => s.pos > phPos);
    const newOrder = [...withPos];
    const dragged  = { id: _dr.id, type: _dr.type };
    if (insertAt === -1) {
      newOrder.push(dragged);
    } else {
      newOrder.splice(insertAt, 0, dragged);
    }

    // Persist _order
    newOrder.forEach((item, idx) => {
      if (item.type === 'deck') {
        const d = state.decks.find(d => d.id === item.id);
        if (d) d._order = idx;
      } else {
        const t = state.topics.find(t => t.id === item.id);
        if (t) t._order = idx;
      }
    });
    save();
  }

  _drReset();

  if (T.currentDeckDetailId) {
    renderDeckDetailContent(T.currentDeckDetailId);
  }
}

function _drCancel() {
  _drCleanListeners();
  _drReset();
}

function _drCleanListeners() {
  document.removeEventListener('pointermove', _drMove);
  document.removeEventListener('pointerup',   _drCommit);
  document.removeEventListener('pointercancel', _drCancel);
}

function _drReset() {
  _dr.el?.classList.remove('is-dragging');
  _dr.ghost?.remove();
  _dr.ph?.remove();
  _dr.active    = false;
  _dr.type      = _dr.id     = _dr.parentKey = null;
  _dr.el        = _dr.ghost  = _dr.ph        = null;
  _dr.timer     = null;
}

// ─── ORDER HELPERS ────────────────────────────────────────────────────────────

const _byOrder = (a, b) => (a._order ?? 9999) - (b._order ?? 9999);

function _nextOrder(siblings) {
  if (!siblings.length) return 0;
  return Math.max(...siblings.map(s => s._order ?? -1)) + 1;
}

// ─── DECK LIST ───────────────────────────────────────────────────────────────

function renderDecks() {
  const grid  = el('decksGrid');
  const empty = el('decksEmpty');
  if (!grid || !empty) return;

  const topLevel = state.decks.filter(d =>
    !d.parentId || !state.decks.some(p => p.id === d.parentId));

  if (!topLevel.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  grid.innerHTML = topLevel.map(renderTopLevelDeckCard).join('');
  attachDeckEvents();
}

function renderTopLevelDeckCard(deck) {
  const allTopics = getTopicsForDeck(deck.id);
  const dueCount  = allTopics.filter(t => isDueToday(ensureCard(t.id))).length;
  const total     = allTopics.length;
  const retention = getDeckRetention(deck.id);

  return `
    <div class="deck-card" data-deck-id="${deck.id}"
         role="button" tabindex="0" aria-label="Open deck ${esc(deck.name)}">
      <div class="dc-bar" style="background:${deck.color}"></div>
      ${dueCount > 0 ? `<div class="dc-due-badge">${dueCount} due</div>` : ''}

      <div class="dc-top">
        <div class="dc-name">${esc(deck.name)}</div>
        <div class="dc-actions">
          <button class="dc-act-btn dc-edit" data-did="${deck.id}" title="Edit deck"
                  aria-label="Edit ${esc(deck.name)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="dc-act-btn dc-del" data-did="${deck.id}" title="Delete deck"
                  aria-label="Delete ${esc(deck.name)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" aria-hidden="true">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>

      ${deck.desc ? `<div class="dc-desc">${esc(deck.desc)}</div>` : ''}

      <div class="dc-stats">
        <div class="dc-stat">
          <div class="dc-stat-val" style="color:${deck.color}">${total}</div>
          <div class="dc-stat-lab">Cards</div>
        </div>
        <div class="dc-stat">
          <div class="dc-stat-val" style="color:var(--red)">${dueCount}</div>
          <div class="dc-stat-lab">Due</div>
        </div>
        <div class="dc-stat">
          <div class="dc-stat-val" style="color:var(--grn)">
            ${retention !== null ? retention + '%' : '—'}
          </div>
          <div class="dc-stat-lab">Retention</div>
        </div>
      </div>
    </div>`;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getTopicsForDeck(deckId) {
  const ids = getSubDeckIds(deckId);
  return state.topics.filter(t => ids.includes(t.deckId));
}

function getDeckRetention(deckId) {
  const rates = getTopicsForDeck(deckId)
    .map(t => getRetention(ensureCard(t.id)))
    .filter(r => r != null);
  return rates.length
    ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length)
    : null;
}

/**
 * Returns 0-indexed depth (0 = top-level, 1 = one level down, …).
 * Max meaningful value is 2 (= 3rd level, cannot have children).
 */
function getDeckDepth(deckId) {
  let depth  = 0;
  let cur    = deckId;
  let safety = 0;
  while (cur && safety++ < 10) {
    const parent = state.decks.find(d => d.id === cur)?.parentId;
    if (!parent) break;
    depth++;
    cur = parent;
  }
  return depth;
}

// ─── CONTAINER DECK HELPERS ──────────────────────────────────────────────────

function isContainerDeck(deckId) {
  return state.decks.some(d => d.parentId === deckId);
}

function migrateToContainer(parentId, newlyCreatedDeckId) {
  const existingSubs = state.decks.filter(
    d => d.parentId === parentId && d.id !== newlyCreatedDeckId
  );
  if (existingSubs.length > 0) return;

  const generalId = uid();
  state.decks.push({
    id:           generalId,
    name:         'General',
    parentId:     parentId,
    isInbox:      true,
    color:        state.decks.find(d => d.id === parentId)?.color,
    scheduleMode: 'fsrs',
    createdAt:    todayStr(),
  });

  state.topics
    .filter(t => t.deckId === parentId)
    .forEach(t => { t.deckId = generalId; });

  save();
}

// ─── DESCRIPTION FIELD ── Feature 3 ─────────────────────────────────────────
//
// The description input is hidden entirely when creating a new deck.
// On edit it becomes visible, wrapped inside a collapsed <details> "Advanced"
// section so it does not clutter the primary creation flow.
//
// On first call this function surgically wraps the desc group in a <details>
// element; subsequent calls just toggle visibility / open state.

function _manageDescField(showForEdit) {
  const descEl = el('deckDesc');
  if (!descEl) return;

  // Find the label+input field group that wraps the textarea
  const fieldGroup = descEl.closest('.field-group')
    || descEl.closest('.form-group')
    || descEl.closest('.modal-field')
    || descEl.parentElement;
  if (!fieldGroup) return;

  // Lazily create the <details> wrapper once
  let details = document.getElementById('deckAdvDetails');
  if (!details) {
    details = document.createElement('details');
    details.id        = 'deckAdvDetails';
    details.className = 'adv-section';

    const summary  = document.createElement('summary');
    summary.textContent = 'Advanced';
    details.appendChild(summary);

    const body     = document.createElement('div');
    body.className = 'adv-body';
    details.appendChild(body);

    // Move fieldGroup into the details body
    fieldGroup.parentNode.insertBefore(details, fieldGroup);
    body.appendChild(fieldGroup);
  }

  if (showForEdit) {
    details.style.display = '';
    details.open = false; // collapsed by default; user opens when needed
  } else {
    details.style.display = 'none';
    details.open = false;
  }
}

// ─── SUBDECK FOLDER HTML (delegates to unified tree for full depth) ──────────

function buildSubDeckFoldersHTML(parentId) {
  // Full recursive tree — the same function used for leaf decks — so that
  // every level of nesting is always visible without an extra click.
  return buildUnifiedTreeHTML(parentId, 0);
}

// ─── DECK GRID EVENTS ────────────────────────────────────────────────────────

function attachDeckEvents() {
  const grid = el('decksGrid');
  if (!grid) return;
  grid.removeEventListener('click',   handleDeckGridClick);
  grid.removeEventListener('keydown', handleDeckGridKeydown);
  grid.addEventListener('click',   handleDeckGridClick);
  grid.addEventListener('keydown', handleDeckGridKeydown);
}

function handleDeckGridClick(e) {
  const card = e.target.closest('.deck-card');
  if (!card) return;
  const deckId = card.dataset.deckId;

  if (e.target.closest('.dc-edit')) {
    e.stopPropagation();
    openEditDeck(deckId);
  } else if (e.target.closest('.dc-del')) {
    e.stopPropagation();
    const deck = state.decks.find(d => d.id === deckId);
    if (!deck) return;
    T.pendingDeleteId   = deckId;
    T.pendingDeleteType = 'deck';
    const msg = el('deleteMsg');
    if (msg) {
      msg.textContent =
        `Delete "${deck.name}" and all its sub-decks and cards? This cannot be undone.`;
    }
    openModal('deleteModal');
  } else {
    openDeckDetail(deckId);
  }
}

function handleDeckGridKeydown(e) {
  if (e.code !== 'Enter' && e.code !== 'Space') return;
  const card = e.target.closest('.deck-card');
  if (!card || e.target.closest('.dc-actions')) return;
  e.preventDefault();
  openDeckDetail(card.dataset.deckId);
}

// ─── CREATE / EDIT DECK ──────────────────────────────────────────────────────

function openEditDeck(deckId) {
  const deck = state.decks.find(d => d.id === deckId);
  if (!deck) return;

  T.editingDeckId = deckId;
  T.selectedColor = deck.color;

  const titleEl   = el('deckModalTitle');
  const nameInput = el('deckName');
  const descInput = el('deckDesc');

  if (titleEl)   titleEl.textContent = 'Edit Deck';
  if (nameInput) nameInput.value     = deck.name;
  if (descInput) descInput.value     = deck.desc || '';

  // Feature 3: show desc in collapsed Advanced section for edit
  _manageDescField(true);

  updateColorPicker(deck.color);
  refreshDeckParentSelect(deckId);

  const parentSel = el('deckParent');
  if (parentSel) {
    parentSel.value = deck.parentId || '';
    Array.from(parentSel.options).forEach(opt => {
      if (opt.value === deckId) opt.disabled = true;
    });
  }

  const mode = deck.scheduleMode || 'fsrs';
  document.querySelectorAll('#deckModeSwitch .mode-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));

  openModal('deckModal');
}

function openNewDeck(parentId = null) {
  T.editingDeckId = null;
  T.selectedColor = DECK_COLORS[0];

  const titleEl   = el('deckModalTitle');
  const nameInput = el('deckName');
  const descInput = el('deckDesc');

  if (titleEl)   titleEl.textContent = parentId ? 'New Sub-Deck' : 'New Deck';
  if (nameInput) nameInput.value = '';
  if (descInput) descInput.value = '';

  // Feature 3: hide description entirely when creating
  _manageDescField(false);

  updateColorPicker(T.selectedColor);
  refreshDeckParentSelect();

  const parentSel = el('deckParent');
  if (parentSel) {
    parentSel.value = parentId || '';
    if (parentId) {
      Array.from(parentSel.options).forEach(opt => {
        if (opt.value === parentId) opt.disabled = false;
      });
    }
  }

  document.querySelectorAll('#deckModeSwitch .mode-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === 'fsrs'));

  openModal('deckModal');
}

function saveDeck() {
  const nameInput = el('deckName');
  const descInput = el('deckDesc');
  const parentSel = el('deckParent');

  const name = nameInput?.value.trim();
  if (!name) { alert('Please enter a deck name.'); return; }

  const scheduleMode = document.querySelector('#deckModeSwitch .mode-tab.active')?.dataset.mode || 'fsrs';
  const parentId     = parentSel?.value || null;
  const color        = T.selectedColor;
  const desc         = descInput?.value.trim() || '';

  // ── Feature 1 & 4: duplicate name check (same name + same parent) ──────────
  const nameLower = name.toLowerCase();
  const duplicate = state.decks.some(d => {
    if (T.editingDeckId && d.id === T.editingDeckId) return false; // skip self
    return d.name.toLowerCase() === nameLower
      && (d.parentId || null) === (parentId || null);
  });
  if (duplicate) {
    alert('A deck with that name already exists here.');
    return;
  }

  // ── Feature 2: depth limit ────────────────────────────────────────────────
  if (parentId) {
    const parentDepth = getDeckDepth(parentId);
    if (parentDepth >= 2) {
      alert('Maximum nesting depth is 3 levels. Move this deck to a higher level.');
      return;
    }
  }

  if (T.editingDeckId) {
    if (parentId === T.editingDeckId) {
      alert('A deck cannot be its own parent.');
      return;
    }
    if (wouldCreateCircularReference(T.editingDeckId, parentId)) {
      alert('This would create a circular reference. Please choose a different parent.');
      return;
    }

    const idx = state.decks.findIndex(d => d.id === T.editingDeckId);
    if (idx !== -1) {
      state.decks[idx] = { ...state.decks[idx], name, desc, color, scheduleMode, parentId };
    }
  } else {
    const newId    = uid();
    const siblings = state.decks.filter(d => (d.parentId || null) === (parentId || null));
    state.decks.push({
      id:           newId,
      name,
      desc,
      color,
      parentId,
      scheduleMode,
      _order:       _nextOrder(siblings),
      createdAt:    todayStr(),
    });
    if (parentId) migrateToContainer(parentId, newId);
  }

  save();
  closeModal('deckModal');
  renderDecks();
  refreshAllDeckSelects();
}

function wouldCreateCircularReference(deckId, newParentId) {
  if (!newParentId) return false;
  let cur = newParentId;
  while (cur) {
    if (cur === deckId) return true;
    cur = state.decks.find(d => d.id === cur)?.parentId || null;
  }
  return false;
}

function deleteDeck(deckId) {
  const deck = state.decks.find(d => d.id === deckId);
  if (deck?.isInbox) {
    const hasCards = state.topics.some(t => t.deckId === deckId);
    if (hasCards) {
      alert('General cannot be deleted while it has cards. Move or delete the cards first.');
      return;
    }
  }

  const allIds = getAllChildDeckIds(deckId, [deckId]);

  state.topics
    .filter(t => allIds.includes(t.deckId))
    .forEach(t => delete state.sm2[t.id]);

  state.topics = state.topics.filter(t => !allIds.includes(t.deckId));
  state.decks  = state.decks.filter(d => !allIds.includes(d.id));

  save();
  renderDecks();
  refreshAllDeckSelects();

  if (T.currentDeckDetailId && allIds.includes(T.currentDeckDetailId)) {
    closeModal('deckDetailModal');
    T.currentDeckDetailId = null;
    T.deckNavStack = [];
  }
}

function getAllChildDeckIds(deckId, collector) {
  state.decks
    .filter(d => d.parentId === deckId)
    .forEach(child => {
      collector.push(child.id);
      getAllChildDeckIds(child.id, collector);
    });
  return collector;
}

function refreshDeckParentSelect(excludeId = null) {
  const sel = el('deckParent');
  if (!sel) return;
  sel.innerHTML = '<option value="">None (top level)</option>';

  function addOptions(parentId, depth) {
    state.decks
      .filter(d => d.parentId === parentId && d.id !== excludeId)
      .sort(_byOrder)
      .forEach(deck => {
        const opt       = document.createElement('option');
        opt.value       = deck.id;
        opt.textContent = '\u00a0'.repeat(depth * 3) + '\u2514 ' + deck.name;
        // Feature 2: disable options that would push new deck beyond level 3
        opt.disabled    = depth >= 2;
        if (opt.disabled) opt.title = 'Maximum nesting depth reached';
        sel.appendChild(opt);
        addOptions(deck.id, depth + 1);
      });
  }

  const allIds = new Set(state.decks.map(d => d.id));
  state.decks
    .filter(d => !d.parentId || !allIds.has(d.parentId))
    .sort(_byOrder)
    .forEach(deck => {
      if (deck.id === excludeId) return;
      const opt       = document.createElement('option');
      opt.value       = deck.id;
      opt.textContent = deck.name;
      sel.appendChild(opt);
      addOptions(deck.id, 1);
    });
}

// ─── DECK DETAIL — NAV STACK ─────────────────────────────────────────────────

function openDeckDetail(deckId) {
  const deck = state.decks.find(d => d.id === deckId);
  if (!deck) return;

  const stackTop = T.deckNavStack[T.deckNavStack.length - 1];
  if (stackTop !== deckId) {
    T.deckNavStack.push(deckId);
  }

  T.currentDeckDetailId = deckId;
  renderDeckDetailContent(deckId);
}

function clearDeckNavStack() {
  T.deckNavStack = [];
}

function renderDeckDetailContent(deckId) {
  const deck = state.decks.find(d => d.id === deckId);
  if (!deck) return;

  const modal = el('deckDetailModal');
  if (!modal) return;

  const allSubIds   = getSubDeckIds(deckId);
  const totalTopics = state.topics.filter(t => allSubIds.includes(t.deckId)).length;
  const directSubs  = state.decks.filter(d => d.parentId === deckId);

  const titleEl        = el('ddTitle');
  const subEl          = el('ddSub');
  const topicContainer = el('ddTopicList');

  if (titleEl) titleEl.textContent = deck.name;
  if (subEl)   subEl.textContent   =
    `${totalTopics} card${totalTopics !== 1 ? 's' : ''}${deck.desc ? ` · ${deck.desc}` : ''}`;
  modal.dataset.deckId = deckId;

  // ── Feature 5: always-visible full tree ───────────────────────────────────
  // buildUnifiedTreeHTML is always used — it recurses into every sub-level so
  // all children are visible without an extra click, regardless of depth.
  if (topicContainer) {
    if (!totalTopics && !directSubs.length) {
      topicContainer.innerHTML = `
        <div class="empty-state" style="padding:40px 20px">
          <div class="es-icon">📭</div>
          <div class="es-msg">No topics or sub-decks yet.</div>
        </div>`;
    } else {
      topicContainer.innerHTML = buildUnifiedTreeHTML(deckId, 0);
      attachUnifiedTreeEvents(topicContainer);
      // Feature 5 drag: attach long-press reorder listener (idempotent)
      _attachDragToContainer(topicContainer);
    }
  }

  const addBtn    = el('ddAddBtn');
  const studyBtn  = el('ddStudyBtn');
  const browseBtn = el('ddBrowseBtn');
  const addSubBtn = el('ddAddSubBtn');
  const resetBtn  = el('ddResetBtn');
  const backBtn   = el('ddBackBtn');

  if (addBtn) {
    addBtn.style.display = isContainerDeck(deckId) ? 'none' : '';
    addBtn.onclick = () => { closeModal('deckDetailModal'); openAddTopic(deckId); };
  }

  if (studyBtn)  studyBtn.onclick  = () => { closeModal('deckDetailModal'); studyDeckById(deckId); };
  if (browseBtn) browseBtn.onclick = () => { closeModal('deckDetailModal'); browseDeckById(deckId); };
  if (addSubBtn) addSubBtn.onclick = () => { closeModal('deckDetailModal'); openNewDeck(deckId); };

  if (resetBtn) resetBtn.onclick = () => {
    T.pendingDeleteId   = deckId;
    T.pendingDeleteType = 'reset';
    const msg = el('deleteMsg');
    if (msg) {
      msg.textContent =
        `Reset all progress for "${deck.name}" and its sub-decks? This cannot be undone.`;
    }
    openModal('deleteModal');
  };

  if (backBtn) {
    backBtn.onclick = () => {
      T.deckNavStack.pop();
      const previous = T.deckNavStack[T.deckNavStack.length - 1];

      if (previous) {
        T.currentDeckDetailId = previous;
        renderDeckDetailContent(previous);
      } else {
        closeModal('deckDetailModal');
        T.currentDeckDetailId = null;
      }
    };
  }

  openModal('deckDetailModal');
}

// ─── UNIFIED TREE ─────────────────────────────────────────────────────────────
//
// Feature 5: buildUnifiedTreeHTML is fully recursive — it renders every
// sub-deck and its children at the correct indentation so the user always sees
// the complete hierarchy without extra clicks.
//
// Each row carries:
//   data-parent-key  — shared key for all siblings at the same level;
//                      used by the drag system to scope reordering.
//   data-type        — 'deck' | 'topic'
//
// Children of a node are rendered immediately after that node row, producing a
// depth-first, always-expanded tree.

/**
 * Returns a depth-aware drag handle.
 *   depth 0 → 6 dots (3 rows × 2)
 *   depth 1 → 4 dots (2 rows × 2)
 *   depth 2 → 2 dots (1 row  × 2)
 */
function _dragHandleHTML(depth) {
  const rows = Math.max(1, 3 - depth);
  let inner  = '';
  for (let r = 0; r < rows; r++) {
    inner += '<span class="dh-r"><span class="dh-d"></span><span class="dh-d"></span></span>';
  }
  return `<div class="drag-handle" aria-label="Hold to reorder" title="Hold to reorder">${inner}</div>`;
}

function buildUnifiedTreeHTML(parentId, depth = 0, ancestorIsLast = []) {
  let html = '';

  // Sort topics and sub-decks together by _order, inbox deck always first
  const nodes = [
    ...state.topics
      .filter(t => t.deckId === parentId)
      .map(t => ({ ...t, _type: 'topic' })),
    ...state.decks
      .filter(d => d.parentId === parentId)
      .map(d => ({ ...d, _type: 'deck' })),
  ].sort((a, b) => {
    if (a.isInbox && !b.isInbox) return -1;
    if (b.isInbox && !a.isInbox) return  1;
    return _byOrder(a, b);
  });

  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1;

    // Build indentation connectors
    let indentHTML = '';
    ancestorIsLast.forEach(wasLast => {
      indentHTML += `<div class="indent-line${wasLast ? ' hidden-line' : ''}"></div>`;
    });
    if (depth > 0) {
      indentHTML += `<div class="indent-line branch${isLast ? ' is-last' : ''}"></div>`;
    }

    // depth-aware dot handle — generated per node so dots shrink with nesting
    const dragHandle = _dragHandleHTML(depth);

    if (node._type === 'deck') {
      const deckTopics = getTopicsForDeck(node.id);
      const newCount   = deckTopics.filter(t => ensureCard(t.id).pile === 'new').length;
      const learnCount = deckTopics.filter(t =>
        ['learning', 'relearning'].includes(ensureCard(t.id).pile)).length;
      const dueCount   = deckTopics.filter(t => isDueToday(ensureCard(t.id))).length;
      const inboxBadge = node.isInbox
        ? `<span class="inbox-badge" title="General inbox sub-deck">📥</span>` : '';

      html += `
        <div class="tree-row${dueCount > 0 ? ' has-due' : ''}${node.isInbox ? ' is-inbox' : ''}"
             data-type="deck"
             data-deck-id="${node.id}"
             data-parent-key="${parentId}">
          <div class="indent-cell">${indentHTML}</div>
          <div class="row-icon" aria-hidden="true">📁</div>
          ${dragHandle}
          <div class="row-label" style="color:${node.color}">${inboxBadge}${esc(node.name)}</div>
          <div class="row-counts">
            <span class="count-pill pill-new"   title="New">${newCount}</span>
            <span class="count-pill pill-learn" title="Learning">${learnCount}</span>
            <span class="count-pill pill-due"   title="Due">${dueCount}</span>
          </div>
          <div class="row-actions">
            <button class="act-btn study-btn dd-study-deck"
                    data-sid="${node.id}"
                    aria-label="Study ${esc(node.name)}">Study</button>
            <button class="act-btn dd-edit-deck"
                    data-sid="${node.id}"
                    aria-label="Edit ${esc(node.name)}">Edit</button>
            <button class="act-btn del-btn dd-del-deck"
                    data-sid="${node.id}"
                    aria-label="Delete ${esc(node.name)}">Delete</button>
          </div>
        </div>
        ${buildUnifiedTreeHTML(node.id, depth + 1, [...ancestorIsLast, isLast])}`;

    } else {
      const card = ensureCard(node.id);
      const pile = card.pile || 'new';
      const stab = card.state ? Math.round(card.state.stability) : 0;
      const ret  = getRetention(card);

      let isDue = false;
      if (pile === 'review' && card.nextReviewAt) {
        isDue = new Date(card.nextReviewAt).toISOString().split('T')[0] <= todayStr();
      } else if ((pile === 'learning' || pile === 'relearning') && card.nextReviewAt) {
        isDue = card.nextReviewAt <= Date.now();
      }

      const pileClass = pile === 'new'      ? 'pill-new'
        : (pile === 'learning' || pile === 'relearning') ? 'pill-learn'
        : 'pill-due';

      const pileIcon = pile === 'new'       ? '🆕'
        : (pile === 'learning' || pile === 'relearning') ? '📖'
        : '🔁';

      const pileTip = pile === 'new'        ? 'New'
        : (pile === 'learning' || pile === 'relearning') ? 'Learning'
        : `Review · S:${stab}d · ${ret}%`;

      html += `
        <div class="tree-row${isDue ? ' has-due' : ''}"
             data-type="topic"
             data-topic-id="${node.id}"
             data-parent-key="${parentId}">
          <div class="indent-cell">${indentHTML}</div>
          <div class="row-icon" aria-hidden="true">📄</div>
          ${dragHandle}
          <div class="row-label">${esc(node.title)}</div>
          <div class="row-counts">
            <span class="count-pill ${pileClass}" title="${esc(pileTip)}">${pileIcon}</span>
          </div>
          <div class="row-actions">
            <button class="act-btn dd-edit-topic"
                    data-tid="${node.id}"
                    aria-label="Edit ${esc(node.title)}">Edit</button>
            <button class="act-btn del-btn dd-del-topic"
                    data-tid="${node.id}"
                    aria-label="Delete ${esc(node.title)}">Delete</button>
          </div>
        </div>`;
    }
  });

  return html;
}

function attachUnifiedTreeEvents(container) {
  container.removeEventListener('click', handleUnifiedTreeClick);
  container.addEventListener('click',   handleUnifiedTreeClick);
}

// ─── UNIFIED TREE EVENT HANDLER ───────────────────────────────────────────────

function handleUnifiedTreeClick(e) {
  const editTopicBtn = e.target.closest('.dd-edit-topic');
  if (editTopicBtn) {
    e.stopPropagation();
    closeModal('deckDetailModal');
    openEditTopic(editTopicBtn.dataset.tid);
    return;
  }

  const delTopicBtn = e.target.closest('.dd-del-topic');
  if (delTopicBtn) {
    e.stopPropagation();
    const tid   = delTopicBtn.dataset.tid;
    const topic = state.topics.find(t => t.id === tid);
    if (!topic) return;
    T.pendingDeleteId   = tid;
    T.pendingDeleteType = 'topic';
    const msg = el('deleteMsg');
    if (msg) msg.textContent = `Delete "${topic.title}"? This cannot be undone.`;
    openModal('deleteModal');
    return;
  }

  const studyDeckBtn = e.target.closest('.dd-study-deck');
  if (studyDeckBtn) {
    e.stopPropagation();
    closeModal('deckDetailModal');
    studyDeckById(studyDeckBtn.dataset.sid);
    return;
  }

  const editDeckBtn = e.target.closest('.dd-edit-deck');
  if (editDeckBtn) {
    e.stopPropagation();
    closeModal('deckDetailModal');
    openEditDeck(editDeckBtn.dataset.sid);
    return;
  }

  const delDeckBtn = e.target.closest('.dd-del-deck');
  if (delDeckBtn) {
    e.stopPropagation();
    const sid  = delDeckBtn.dataset.sid;
    const deck = state.decks.find(d => d.id === sid);
    if (!deck) return;
    T.pendingDeleteId   = sid;
    T.pendingDeleteType = 'deck';
    const msg = el('deleteMsg');
    if (msg) {
      msg.textContent =
        `Delete "${deck.name}" and all its sub-decks and cards? This cannot be undone.`;
    }
    openModal('deleteModal');
    return;
  }

  // Clicking a deck row (not on action buttons or drag handle) → drill in
  const deckRow = e.target.closest('.tree-row[data-type="deck"]');
  if (deckRow && !e.target.closest('.row-actions') && !e.target.closest('.drag-handle')) {
    const id = deckRow.dataset.deckId;
    if (id) openDeckDetail(id);
    return;
  }

  // Clicking a topic row → open flashcard
  const topicRow = e.target.closest('.tree-row[data-type="topic"]');
  if (topicRow
      && !e.target.closest('.row-actions')
      && !e.target.closest('.drag-handle')) {
    const topicId = topicRow.dataset.topicId;
    if (!topicId) return;
    const deckContext = T.currentDeckDetailId || 'all';
    closeModal('deckDetailModal');
    T.deckNavStack = [];
    if (typeof openFlashcardTopic === 'function') {
      openFlashcardTopic(topicId, { deckFilter: deckContext, dateFilter: 'all' });
    }
  }
}

// ─── PROGRESS RESET ──────────────────────────────────────────────────────────

function resetDeckProgress(deckId) {
  getSubDeckIds(deckId).forEach(did => {
    state.topics
      .filter(t => t.deckId === did)
      .forEach(t => { state.sm2[t.id] = fsrsInit(t.id); });
  });
  save();
  closeModal('deckDetailModal');
  T.deckNavStack = [];
  renderDecks();
}

// ─── STUDY / BROWSE ───────────────────────────────────────────────────────────

/**
 * renderFC() is called before loadFlashcards(deckId) so the deck-filter
 * dropdown is fully populated before we programmatically set its value.
 */
function studyDeckById(deckId) {
  T.studyReturnDeckId = deckId;
  if (typeof closeModal === 'function') closeModal('deckDetailModal');
  switchSection('flashcards');
  if (typeof renderFC === 'function') renderFC();
  loadFlashcards(deckId);
}

function browseDeckById(deckId) {
  const allIds = getSubDeckIds(deckId);
  const cards  = state.topics.filter(t => allIds.includes(t.deckId));

  if (!cards.length) {
    alert('No cards in this deck yet.');
    return;
  }

  state.browseQueue  = cards;
  state.browseDeckId = deckId;
  switchSection('browse');
}

// ─── EVENT SETUP ─────────────────────────────────────────────────────────────

function setupDeckEvents() {
  // Inject drag CSS on first setup call (DOM guaranteed ready here)
  _injectDragCSS();

  el('newDeckBtn')?.addEventListener('click', () => openNewDeck());
  el('createFirstDeckBtn')?.addEventListener('click', () => openNewDeck());
  el('importDeckCsvBtn')?.addEventListener('click', () => switchSection('import'));
  el('saveDeckBtn')?.addEventListener('click', saveDeck);

  el('deckModeSwitch')?.addEventListener('click', e => {
    const btn = e.target.closest('.mode-tab');
    if (!btn) return;
    document.querySelectorAll('#deckModeSwitch .mode-tab').forEach(b =>
      b.classList.remove('active'));
    btn.classList.add('active');
  });

  el('colorRow')?.addEventListener('click', e => {
    const dot = e.target.closest('.color-dot');
    if (!dot) return;
    T.selectedColor = dot.dataset.color;
    updateColorPicker(T.selectedColor);
  });
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

window.renderDecks               = renderDecks;
window.getTopicsForDeck          = getTopicsForDeck;
window.getDeckRetention          = getDeckRetention;
window.getDeckDepth              = getDeckDepth;
window.isContainerDeck           = isContainerDeck;
window.migrateToContainer        = migrateToContainer;
window.buildSubDeckFoldersHTML   = buildSubDeckFoldersHTML;
window.openEditDeck              = openEditDeck;
window.openNewDeck               = openNewDeck;
window.saveDeck                  = saveDeck;
window.deleteDeck                = deleteDeck;
window.openDeckDetail            = openDeckDetail;
window.clearDeckNavStack         = clearDeckNavStack;
window.renderDeckDetailContent   = renderDeckDetailContent;
window.resetDeckProgress         = resetDeckProgress;
window.studyDeckById             = studyDeckById;
window.browseDeckById            = browseDeckById;
window.setupDeckEvents           = setupDeckEvents;