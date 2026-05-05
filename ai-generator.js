'use strict';

// ============================================
// MNEMO — AI Flashcard Generator Module (Enhanced)
// Uses Groq API (free tier) with retry & robust prompt
// Plugs into existing state, modals, and deck system
// ============================================

const AI_GEN = {
  isGenerating: false,
  previewCards: [],
  selectedDeckId: null,
};

// ── Default API Key (pre‑filled)
const DEFAULT_GROQ_KEY = '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';

// ── Helper: Delay for retries
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── API Call (Groq) with retry & enhanced prompt ─────────────────────────────

async function callGroqAPI(userText, cardType = 'mixed', retries = 3) {
  let apiKey = state.settings?.groqApiKey || '';
  if (!apiKey) {
    apiKey = DEFAULT_GROQ_KEY;
    if (!state.settings) state.settings = {};
    state.settings.groqApiKey = apiKey;
    if (typeof saveImmediate === 'function') saveImmediate();
  }

  // Build type instruction
  let typeInstruction = '';
  switch (cardType) {
    case 'cloze':
      typeInstruction = `Create ONLY cloze deletion flashcards using {{c1::word}} syntax (Anki-compatible). 
Each card's "title" must be a sentence with exactly one {{c1::...}} blank. 
The "content" field can be an empty string or an optional hint/explanation.`;
      break;
    case 'standard':
      typeInstruction = `Create ONLY standard Q&A flashcards. 
Each card's "title" must be a clear question, and "content" the concise answer (max 30 words).`;
      break;
    default: // mixed
      typeInstruction = `Mix standard Q&A cards and cloze deletion cards ({{c1::word}} syntax). 
Choose the type that best fits each fact. Use cloze for definitions, key terms, or fill-in-the-blank facts. 
Use Q&A for processes, cause/effect, or multi-part answers.`;
  }

  const prompt = `You are an expert flashcard creator for spaced repetition (e.g., Anki). Convert the following notes into atomic flashcards – each card tests ONE specific fact or concept.

**Rules:**
- Generate between 5 and 25 flashcards. If the input is very long (>6000 characters), you may generate up to 30.
- Each card must test exactly one fact or concept (atomic). Never combine multiple facts into one card.
- For standard Q&A: "title" = question, "content" = answer (max 30 words, concise but complete).
- For cloze: "title" = a sentence with {{c1::the key term}} blank. "content" may be empty or an optional note.
- Use {{c1::...}} for cloze blanks (Anki-compatible). Never use {{word}} without the "c1::".
- Return ONLY valid JSON, no markdown, no extra text.
- JSON format: {"cards": [{"title": "...", "content": "...", "type": "standard" | "cloze"}]}

**Example input:**
"Photosynthesis takes place in chloroplasts. The light-dependent reactions occur in thylakoid membranes, while the Calvin cycle happens in the stroma."

**Example output:**
{"cards": [
  {"title": "Where does photosynthesis occur?", "content": "In chloroplasts.", "type": "standard"},
  {"title": "Where do light-dependent reactions occur?", "content": "Thylakoid membranes.", "type": "standard"},
  {"title": "Photosynthesis occurs in the {{c1::chloroplasts}}.", "content": "", "type": "cloze"}
]}

**Now convert the following notes:**
${userText}`;

  let lastError = null;
  let attempt = 0;

  while (attempt <= retries) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 4096,
          response_format: { type: 'json_object' }
        })
      });

      if (response.status === 429) { // Rate limit
        const retryAfter = response.headers.get('retry-after') || (Math.pow(2, attempt) * 1.5);
        console.warn(`Groq rate limit hit. Retry after ${retryAfter}s (attempt ${attempt + 1}/${retries + 1})`);
        await delay(retryAfter * 1000);
        attempt++;
        continue;
      }

      if (!response.ok) {
        let errorMsg = `Groq API error: HTTP ${response.status}`;
        try {
          const errData = await response.json();
          errorMsg = errData.error?.message || errorMsg;
        } catch (e) {}
        throw new Error(errorMsg);
      }

      const data = await response.json();
      const rawText = data.choices?.[0]?.message?.content;
      if (!rawText) throw new Error('Empty response from Groq API.');

      const clean = rawText.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);

      // Validate cards array
      if (!parsed.cards || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
        throw new Error('Groq returned no cards. Try rephrasing your notes.');
      }

      // Validate each card's structure
      const validCards = [];
      for (const card of parsed.cards) {
        if (!card.title || typeof card.title !== 'string') {
          console.warn('Skipping card: missing title', card);
          continue;
        }
        if (card.type !== 'standard' && card.type !== 'cloze') {
          console.warn('Invalid card type, defaulting to standard', card);
          card.type = 'standard';
        }
        if (card.type === 'standard' && (!card.content || typeof card.content !== 'string')) {
          console.warn('Standard card missing content, setting empty', card);
          card.content = card.content || '';
        }
        if (card.type === 'cloze') {
          // Ensure cloze uses {{c1::...}} format – warn but keep as is
          if (!card.title.match(/\{\{c?\d*::/)) {
            console.warn('Cloze card missing proper syntax, keeping as is', card.title);
          }
          card.content = card.content || ''; // empty string allowed
        }
        validCards.push(card);
      }

      if (validCards.length === 0) {
        throw new Error('No valid cards after validation. AI response malformed.');
      }

      return validCards;

    } catch (err) {
      lastError = err;
      if (err.message.includes('429') || err.message.includes('rate limit')) {
        // Already handled above, but fallback
        const wait = Math.pow(2, attempt) * 1.5;
        console.warn(`Rate limit error, retrying in ${wait}s...`);
        await delay(wait * 1000);
        attempt++;
      } else if (err.message.includes('JSON') || err.message.includes('parse')) {
        // Malformed JSON – no retry, fail fast
        throw new Error(`AI returned invalid JSON: ${err.message}`);
      } else {
        attempt++;
        if (attempt > retries) break;
        await delay(1000 * attempt);
      }
    }
  }

  throw lastError || new Error('Failed to generate cards after multiple attempts.');
}

// ── Generate Button Handler (with loading state) ─────────────────────────────

async function handleAIGenerate() {
  if (AI_GEN.isGenerating) return;

  const textArea = el('aiGenTextarea');
  const deckSel  = el('aiGenDeckSelect');
  const typeSel  = el('aiGenCardType');
  const generateBtn = el('aiGenBtn');

  const text = textArea?.value.trim();
  if (!text) {
    showAIGenError('Please paste some notes or text first.');
    return;
  }
  if (text.length < 20) {
    showAIGenError('Text is too short. Add more content for better cards (min 20 chars).');
    return;
  }

  const deckId = deckSel?.value;
  if (!deckId) {
    showAIGenError('Please select a target deck.');
    return;
  }

  AI_GEN.selectedDeckId = deckId;
  const cardType = typeSel?.value || 'mixed';

  AI_GEN.isGenerating = true;
  if (generateBtn) {
    generateBtn.disabled = true;
    generateBtn.textContent = '✨ Generating… (may take a few seconds)';
  }

  hideAIGenError();
  hideAIGenPreview();
  showAIGenSpinner(true);

  try {
    const cards = await callGroqAPI(text, cardType, 3);
    AI_GEN.previewCards = cards;
    renderAIGenPreview(cards, deckId);
  } catch (err) {
    let friendlyMsg = err.message;
    if (friendlyMsg.includes('rate limit') || friendlyMsg.includes('429')) {
      friendlyMsg = 'Groq rate limit reached (30/min). Please wait a moment and try again.';
    } else if (friendlyMsg.includes('API key')) {
      friendlyMsg = 'Invalid or missing Groq API key. Check Settings → AI Generator.';
    } else if (friendlyMsg.includes('JSON')) {
      friendlyMsg = 'AI response format error. Try simplifying your notes or changing card type.';
    }
    showAIGenError(friendlyMsg);
    console.error('[AI Gen]', err);
  } finally {
    AI_GEN.isGenerating = false;
    showAIGenSpinner(false);
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.textContent = '✨ Generate Cards';
    }
  }
}

// ── Preview Rendering (unchanged) ─────────────────────────────────────────────

function renderAIGenPreview(cards, deckId) {
  const preview = el('aiGenPreview');
  if (!preview) return;

  const deck = state.decks.find(d => d.id === deckId) || { name: 'Selected Deck', color: '#7B6EF6' };

  preview.innerHTML = `
    <div class="aig-preview-header">
      <div class="aig-preview-title">
        <span class="aig-preview-count">${cards.length}</span> cards generated
        <span class="aig-preview-deck" style="color:${deck.color}">→ ${esc(deck.name)}</span>
      </div>
      <div class="aig-preview-actions">
        <button class="aig-select-all" id="aiGenSelectAll">Select All</button>
        <button class="btn-primary" id="aiGenImportBtn" style="font-size:0.82rem;padding:10px 20px">
          ✓ Import Selected
        </button>
      </div>
    </div>
    <div class="aig-cards-list" id="aiGenCardsList"></div>
  `;

  const list = el('aiGenCardsList');
  cards.forEach((card, i) => {
    const item = document.createElement('div');
    item.className = 'aig-card-item';
    item.dataset.index = i;

    const isCloze = card.type === 'cloze';
    let displayTitle = esc(card.title);
    if (isCloze) {
      displayTitle = card.title.replace(/\{\{c?\d*::(.+?)\}\}/g, '<span class="aig-cloze-blank">[$1]</span>');
    }

    item.innerHTML = `
      <label class="aig-card-check-label">
        <input type="checkbox" class="aig-card-checkbox" data-index="${i}" checked>
        <div class="aig-card-content">
          <div class="aig-card-type-badge ${isCloze ? 'badge-cloze' : 'badge-standard'}">
            ${isCloze ? '{{cloze}}' : 'Q&A'}
          </div>
          <div class="aig-card-front">${displayTitle}</div>
          ${card.content ? `<div class="aig-card-back">${esc(card.content)}</div>` : ''}
        </div>
        <div class="aig-card-remove" data-index="${i}" title="Remove this card">×</div>
      </label>
    `;

    list.appendChild(item);
  });

  preview.classList.remove('hidden');
  // Hide placeholder if exists
  const placeholder = el('aiGenPlaceholder');
  if (placeholder) placeholder.style.display = 'none';

  // Events
  el('aiGenImportBtn')?.addEventListener('click', importSelectedCards);
  el('aiGenSelectAll')?.addEventListener('click', () => {
    const allChecked = document.querySelectorAll('.aig-card-checkbox:checked').length === cards.length;
    document.querySelectorAll('.aig-card-checkbox').forEach(cb => { cb.checked = !allChecked; });
    el('aiGenSelectAll').textContent = allChecked ? 'Select All' : 'Deselect All';
  });

  list.addEventListener('click', e => {
    const removeBtn = e.target.closest('.aig-card-remove');
    if (removeBtn) {
      const idx = parseInt(removeBtn.dataset.index);
      removeBtn.closest('.aig-card-item')?.remove();
      AI_GEN.previewCards[idx] = null;
    }
  });
}

// ── Import Selected Cards (unchanged) ─────────────────────────────────────────

function importSelectedCards() {
  const checkboxes = document.querySelectorAll('.aig-card-checkbox:checked');
  if (!checkboxes.length) {
    showAIGenError('No cards selected.');
    return;
  }

  const deckId = AI_GEN.selectedDeckId;
  if (!deckId) {
    showAIGenError('Target deck lost. Please regenerate.');
    return;
  }

  let imported = 0;
  const today = todayStr();

  checkboxes.forEach(cb => {
    const idx = parseInt(cb.dataset.index);
    const card = AI_GEN.previewCards[idx];
    if (!card) return;

    const newId = uid();
    state.topics.push({
      id:         newId,
      title:      card.title || '',
      content:    card.content || '',
      deckId:     deckId,
      startDate:  today,
      type:       card.type === 'cloze' ? 'cloze' : 'standard',
      isPastFixed: false,
      createdAt:  today,
    });

    const sm2Card = fsrsInit(newId);
    sm2Card.firstSeenAt = null;
    state.sm2[newId] = sm2Card;
    imported++;
  });

  if (typeof saveImmediate === 'function') saveImmediate();
  if (typeof IndexManager !== 'undefined') IndexManager.scheduleRebuild();
  if (typeof refreshAllDeckSelects === 'function') refreshAllDeckSelects();

  closeModal('aiGeneratorModal');

  if (typeof showToast === 'function') {
    showToast(`✨ ${imported} AI cards added to deck!`, 'success');
  } else {
    alert(`✨ ${imported} cards imported successfully!`);
  }

  if (typeof renderDecks === 'function') renderDecks();
  if (typeof renderToday === 'function') renderToday();

  // Reset state
  AI_GEN.previewCards = [];
  AI_GEN.selectedDeckId = null;
}

// ── UI Helpers (unchanged) ────────────────────────────────────────────────────

function showAIGenError(msg) {
  const errEl = el('aiGenError');
  if (errEl) {
    errEl.textContent = '⚠️ ' + msg;
    errEl.classList.remove('hidden');
  }
}

function hideAIGenError() {
  el('aiGenError')?.classList.add('hidden');
}

function showAIGenSpinner(show) {
  el('aiGenSpinner')?.classList.toggle('hidden', !show);
}

function hideAIGenPreview() {
  el('aiGenPreview')?.classList.add('hidden');
  const placeholder = el('aiGenPlaceholder');
  if (placeholder) placeholder.style.display = 'flex';
}

function populateAIGenDeckSelect() {
  const sel = el('aiGenDeckSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Select a deck —</option>';

  const allIds = new Set(state.decks.map(d => d.id));

  function addOptions(parentId, depth) {
    state.decks
      .filter(d => d.parentId === parentId)
      .forEach(deck => {
        const opt = document.createElement('option');
        opt.value = deck.id;
        opt.textContent = '\u00a0'.repeat(depth * 3) + '\u2514 ' + deck.name;
        sel.appendChild(opt);
        addOptions(deck.id, depth + 1);
      });
  }

  state.decks
    .filter(d => !d.parentId || !allIds.has(d.parentId))
    .forEach(deck => {
      const opt = document.createElement('option');
      opt.value = deck.id;
      opt.textContent = deck.name;
      sel.appendChild(opt);
      addOptions(deck.id, 1);
    });
}

// ── Open Modal ────────────────────────────────────────────────────────────────

function openAIGenerator() {
  // Reset state
  AI_GEN.previewCards = [];
  AI_GEN.isGenerating = false;

  // Reset UI
  const textArea = el('aiGenTextarea');
  if (textArea) textArea.value = '';
  hideAIGenError();
  hideAIGenPreview();
  showAIGenSpinner(false);

  const btn = el('aiGenBtn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '✨ Generate Cards';
  }

  populateAIGenDeckSelect();
  openModal('aiGeneratorModal');
}

// ── Settings: Groq API Key ────────────────────────────────────────────────────

function renderAISettings() {
  const inp = el('setGroqKey');
  if (inp) {
    const existingKey = state.settings?.groqApiKey;
    inp.value = existingKey || DEFAULT_GROQ_KEY;
    if (!existingKey && state.settings) {
      state.settings.groqApiKey = DEFAULT_GROQ_KEY;
      if (typeof saveImmediate === 'function') saveImmediate();
    }
  }
}

function saveGroqKey() {
  const key = el('setGroqKey')?.value.trim();
  if (!state.settings) state.settings = {};
  state.settings.groqApiKey = key || '';
  if (typeof saveImmediate === 'function') saveImmediate();

  const status = el('groqKeySaved');
  if (status) {
    status.textContent = key ? '✓ Key saved' : '✓ Key cleared';
    status.style.color = 'var(--grn)';
    setTimeout(() => { status.textContent = ''; }, 2500);
  }
}

// ── Event Setup ───────────────────────────────────────────────────────────────

function setupAIGeneratorEvents() {
  document.getElementById('openAIGeneratorBtn')?.addEventListener('click', openAIGenerator);
  el('aiGenBtn')?.addEventListener('click', handleAIGenerate);

  el('aiGenTextarea')?.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleAIGenerate();
    }
  });

  el('aiGenTextarea')?.addEventListener('input', e => {
    const count = el('aiGenCharCount');
    if (count) count.textContent = `${e.target.value.length.toLocaleString()} chars`;
  });

  el('saveGroqKeyBtn')?.addEventListener('click', saveGroqKey);
}

// ── Inject Modal HTML & Settings Card (enhanced version with placeholder) ─────

function addAIGeneratorToUI() {
  // ── 1. Modal ──────────────────────────────────────────────────────────────
  if (!el('aiGeneratorModal')) {
    const modal = document.createElement('div');
    modal.className = 'modal-back hidden';
    modal.id = 'aiGeneratorModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'aiGenModalTitle');

    modal.innerHTML = `
      <div class="modal modal-xl" style="max-width:860px">
        <div class="modal-head">
          <div>
            <h2 class="modal-title" id="aiGenModalTitle">✨ AI Flashcard Generator</h2>
            <p class="modal-sub">Powered by Groq · Paste notes, get study-ready cards · Free tier: 30 req/min (auto-retry on rate limit)</p>
          </div>
          <button class="modal-close" data-modal-close="aiGeneratorModal" aria-label="Close">✕</button>
        </div>

        <div class="modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:22px;align-items:start">

          <!-- LEFT: Input -->
          <div style="display:flex;flex-direction:column;gap:14px">
            <div class="field">
              <label class="field-label">Your Notes / Text</label>
              <textarea
                id="aiGenTextarea"
                class="field-input field-ta"
                style="min-height:240px;resize:vertical;font-size:0.84rem;line-height:1.7"
                placeholder="Paste lecture notes, a textbook paragraph, a Wikipedia article, or any text you want to turn into flashcards…

Ctrl+Enter to generate"></textarea>
              <div style="display:flex;justify-content:space-between;font-size:0.66rem;color:var(--ink3);margin-top:4px">
                <span id="aiGenCharCount">0 chars</span>
                <span>Ctrl+Enter to generate</span>
              </div>
            </div>

            <div class="field-row-2">
              <div class="field">
                <label class="field-label">Target Deck</label>
                <select id="aiGenDeckSelect" class="field-input" style="font-size:0.84rem">
                  <option value="">— Select a deck —</option>
                </select>
              </div>
              <div class="field">
                <label class="field-label">Card Type</label>
                <select id="aiGenCardType" class="field-input" style="font-size:0.84rem">
                  <option value="mixed">Mixed (Q&A + Cloze)</option>
                  <option value="standard">Q&A Only</option>
                  <option value="cloze">Cloze Only</option>
                </select>
              </div>
            </div>

            <button class="btn-primary" id="aiGenBtn" style="font-size:0.94rem;padding:15px 28px;width:100%">
              ✨ Generate Cards
            </button>

            <div id="aiGenError" class="hidden" style="
              font-size:0.78rem;color:var(--red);
              padding:11px 15px;border-radius:var(--r);
              background:var(--red-d);border:1px solid var(--red);
              line-height:1.5;
            "></div>

            <div id="aiGenSpinner" class="hidden" style="display:flex;align-items:center;gap:12px;color:var(--ink3);font-size:0.82rem">
              <div class="aig-spinner"></div>
              <span>Groq is generating cards… usually takes 2–5 seconds. Rate limits auto-retry.</span>
            </div>
          </div>

          <!-- RIGHT: Preview -->
          <div id="aiGenPreview" class="hidden" style="max-height:540px;overflow-y:auto;display:flex;flex-direction:column;gap:12px;">
          </div>

          <!-- RIGHT: Placeholder when no preview yet -->
          <div id="aiGenPlaceholder" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:var(--ink3);text-align:center;min-height:280px;border:2px dashed var(--bord);border-radius:var(--r-lg);padding:28px">
            <div style="font-size:3rem;filter:drop-shadow(0 0 20px var(--acc-d))">🚀</div>
            <div style="font-size:0.86rem;line-height:1.7">Generated cards will appear here.<br>Review and select before importing.</div>
          </div>

        </div>

        <div class="modal-foot" style="justify-content:space-between;align-items:center">
          <div style="font-size:0.72rem;color:var(--ink3)">
            Your API key is stored locally · Text is sent to Groq Cloud · Auto-retry on rate limits
          </div>
          <button class="btn-secondary" data-modal-close="aiGeneratorModal">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  // ── 2. Settings card (Groq) ───────────────────────────────────────────────
  if (!el('aiSettingsCard')) {
    const settingsLayout = el('section-settings')?.querySelector('.settings-layout');
    if (settingsLayout) {
      const card = document.createElement('div');
      card.className = 'settings-card';
      card.id = 'aiSettingsCard';
      card.innerHTML = `
        <div class="sc-title">✨ AI Generator (Groq)</div>
        <p class="sc-desc">
          Generate flashcards from any text using Groq's ultra-fast free tier.
          Get your free API key at
          <a href="https://console.groq.com" target="_blank" rel="noopener"
             style="color:var(--acc);text-decoration:none">console.groq.com</a>
          (no credit card required, 30 requests/minute with automatic retry).
        </p>
        <div class="field" style="margin-top:4px">
          <label class="field-label" for="setGroqKey">Groq API Key</label>
          <div style="display:flex;gap:10px">
            <input
              class="field-input"
              id="setGroqKey"
              type="password"
              placeholder="gsk_..."
              style="flex:1;font-family:'JetBrains Mono',monospace;font-size:0.8rem"
              autocomplete="off"
            >
            <button class="btn-secondary" id="saveGroqKeyBtn" style="white-space:nowrap;padding:10px 18px">Save</button>
          </div>
          <span id="groqKeySaved" style="font-size:0.7rem;margin-top:3px;display:block"></span>
        </div>
        <button class="btn-primary" id="openAIGeneratorBtn" style="margin-top:8px;width:100%">
          ✨ Open AI Generator
        </button>
      `;
      settingsLayout.prepend(card);
    }
  }

  // ── 3. Quick-access button in Flashcards header ───────────────────────────
  const fcHeader = el('section-flashcards')?.querySelector('.sec-header-right');
  if (fcHeader && !el('aiGenQuickBtn')) {
    const quickBtn = document.createElement('button');
    quickBtn.className = 'btn-secondary';
    quickBtn.id = 'aiGenQuickBtn';
    quickBtn.textContent = '✨ AI Generate';
    quickBtn.addEventListener('click', openAIGenerator);
    fcHeader.prepend(quickBtn);
  }

  // ── 4. CSS (unchanged, but ensure .aig-spinner exists) ────────────────────
  if (!el('aiGenStyles')) {
    const style = document.createElement('style');
    style.id = 'aiGenStyles';
    style.textContent = `
      /* Spinner */
      .aig-spinner {
        width: 18px; height: 18px;
        border: 2px solid var(--bord);
        border-top-color: var(--acc);
        border-radius: 50%;
        animation: rotate 0.8s linear infinite;
        flex-shrink: 0;
      }
      @keyframes rotate {
        to { transform: rotate(360deg); }
      }

      /* Preview header */
      .aig-preview-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 10px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--bord2);
      }
      .aig-preview-title {
        font-size: 0.82rem;
        font-weight: 700;
        color: var(--ink2);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .aig-preview-count {
        font-family: 'Fraunces', serif;
        font-size: 1.4rem;
        font-weight: 900;
        color: var(--acc);
        text-shadow: 0 0 20px var(--acc-d);
      }
      .aig-preview-deck {
        font-size: 0.75rem;
        font-weight: 800;
        padding: 3px 10px;
        border-radius: 20px;
        background: var(--acc-d);
      }
      .aig-preview-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .aig-select-all {
        font-size: 0.74rem;
        font-weight: 700;
        color: var(--ink3);
        padding: 7px 14px;
        border-radius: var(--r);
        border: 1px solid var(--bord);
        background: var(--surf2);
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .aig-select-all:hover {
        color: var(--acc);
        border-color: var(--acc-d2);
        background: var(--acc-d);
      }

      /* Card list */
      .aig-cards-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .aig-card-item {
        border-radius: var(--r);
        border: 1px solid var(--bord2);
        background: linear-gradient(135deg, var(--surf2), var(--surf3));
        transition: all 0.2s ease;
        animation: slideInRight 0.3s ease both;
        position: relative;
        overflow: hidden;
      }
      @keyframes slideInRight {
        from { opacity: 0; transform: translateX(10px); }
        to { opacity: 1; transform: translateX(0); }
      }
      .aig-card-item:hover {
        border-color: var(--acc-d2);
        transform: translateX(-3px);
      }

      .aig-card-check-label {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 12px 14px;
        cursor: pointer;
        width: 100%;
      }

      .aig-card-checkbox {
        width: 16px;
        height: 16px;
        margin-top: 3px;
        accent-color: var(--acc);
        flex-shrink: 0;
        cursor: pointer;
      }

      .aig-card-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 5px;
        min-width: 0;
      }

      .aig-card-type-badge {
        font-size: 0.56rem;
        font-weight: 800;
        letter-spacing: 0.1em;
        padding: 2px 8px;
        border-radius: 10px;
        width: fit-content;
        text-transform: uppercase;
      }
      .badge-standard {
        background: var(--acc-d);
        color: var(--acc);
      }
      .badge-cloze {
        background: var(--grn-d);
        color: var(--grn);
        font-family: 'JetBrains Mono', monospace;
      }

      .aig-card-front {
        font-size: 0.83rem;
        font-weight: 600;
        color: var(--ink);
        line-height: 1.5;
      }
      .aig-cloze-blank {
        display: inline-block;
        background: var(--acc-d2);
        color: var(--acc);
        padding: 1px 6px;
        border-radius: 4px;
        font-weight: 800;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.78em;
      }
      .aig-card-back {
        font-size: 0.74rem;
        color: var(--ink3);
        line-height: 1.5;
        border-top: 1px dashed var(--bord2);
        padding-top: 5px;
        margin-top: 2px;
      }

      .aig-card-remove {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        background: var(--red-d);
        color: var(--red);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.9rem;
        font-weight: 900;
        cursor: pointer;
        opacity: 0;
        transition: all 0.2s ease;
        line-height: 1;
      }
      .aig-card-item:hover .aig-card-remove {
        opacity: 1;
      }
      .aig-card-remove:hover {
        background: var(--red);
        color: #fff;
        transform: scale(1.15);
      }

      .aig-card-item:has(.aig-card-checkbox:not(:checked)) {
        opacity: 0.45;
      }
    `;
    document.head.appendChild(style);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initAIGenerator() {
  addAIGeneratorToUI();
  setupAIGeneratorEvents();
  renderAISettings();
}

// Run after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAIGenerator);
} else {
  setTimeout(initAIGenerator, 200);
}

// ── Exports ───────────────────────────────────────────────────────────────────

window.openAIGenerator       = openAIGenerator;
window.handleAIGenerate      = handleAIGenerate;
window.importSelectedCards   = importSelectedCards;
window.renderAISettings      = renderAISettings;
window.saveGroqKey           = saveGroqKey;
window.initAIGenerator       = initAIGenerator;