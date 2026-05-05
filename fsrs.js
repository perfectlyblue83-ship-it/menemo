/**
 * FSRS-6 — Corrected JavaScript implementation
 * Reference: py-fsrs (official Python implementation)
 *
 * Bug fixes vs. previous version:
 *  1. shortTermStability: S^(-w[19]) is a multiplicative factor OUTSIDE exp(),
 *     not inside.  Was: exp(w17*(g-3+w18)*S^-w19). Now: exp(w17*(g-3+w18)) * S^-w19
 *  2. nextDifficulty: mean-reversion target must use the UNCLAMPED initialDifficulty
 *     for Easy (can be ~-4.77 with defaults). Was: clamped (=1.0). Intermediate newD
 *     also must NOT be clamped before mean-reversion.
 *  3. computeNewState: same-day Again must use shortTermStability(), not
 *     stabilityAfterLapse(). Python's _short_term_stability covers all ratings.
 *  4. Fuzzing: must be additive (±delta days), matching Python's FUZZ_RANGES.
 *     Was: multiplicative percentage which diverges significantly at large intervals.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const SCHEDULER_CONFIG = {
  LEARNING_STEPS: [1, 10],       // minutes
  RELEARNING_STEPS: [10],        // minutes
  GRADUATING_INTERVAL: 1,        // days
  EASY_INTERVAL: 4,              // days
  DESIRED_RETENTION: 0.9,
  MAX_INTERVAL: 36500,
  MIN_INTERVAL: 1,
  MAX_LOG_ENTRIES: 1000,
  ENABLE_FUZZ: true,
};

function setSchedulerConfig(config) {
  Object.assign(SCHEDULER_CONFIG, config);
  if (!SCHEDULER_CONFIG.LEARNING_STEPS.length)   SCHEDULER_CONFIG.LEARNING_STEPS   = [1];
  if (!SCHEDULER_CONFIG.RELEARNING_STEPS.length) SCHEDULER_CONFIG.RELEARNING_STEPS = [1];
  if (SCHEDULER_CONFIG.MIN_INTERVAL < 1) SCHEDULER_CONFIG.MIN_INTERVAL = 1;
  if (SCHEDULER_CONFIG.MAX_INTERVAL < SCHEDULER_CONFIG.MIN_INTERVAL)
    SCHEDULER_CONFIG.MAX_INTERVAL = SCHEDULER_CONFIG.MIN_INTERVAL;
}

// ============================================================================
// CONSTANTS & TYPES
// ============================================================================

const GRADES = {
  AGAIN: 0,
  HARD:  1,
  GOOD:  2,
  EASY:  3,
};

const PILES = {
  NEW:        'new',
  LEARNING:   'learning',
  REVIEW:     'review',
  RELEARNING: 'relearning',
};

// FSRS-6 default parameters (21 values) — identical to py-fsrs
const DEFAULT_FSRS_PARAMS = Object.freeze([
  0.212,  // w0  initial stability: Again
  1.2931, // w1  initial stability: Hard
  2.3065, // w2  initial stability: Good
  8.2956, // w3  initial stability: Easy
  6.4133, // w4  initial difficulty baseline
  0.8334, // w5  initial difficulty rating scaling
  3.0194, // w6  difficulty update weight
  0.001,  // w7  mean-reversion factor
  1.8722, // w8  recall stability: exp factor
  0.1666, // w9  recall stability: stability power (negative)
  1.4835, // w10 recall stability: spacing exponent
  0.796,  // w11 lapse stability: scale
  0.0614, // w12 lapse stability: difficulty exponent
  0.2629, // w13 lapse stability: stability exponent
  1.6483, // w14 lapse stability: retrievability factor
  0.6014, // w15 hard penalty multiplier
  1.8729, // w16 easy bonus multiplier
  0.5425, // w17 short-term: grade weight
  0.0912, // w18 short-term: offset
  0.0658, // w19 short-term: stability damping exponent
  0.1542, // w20 forgetting-curve decay (positive; Python stores as negative)
]);

// Additive fuzz ranges matching py-fsrs exactly
const FUZZ_RANGES = [
  { start: 2.5,       end: 7.0,      factor: 0.15 },
  { start: 7.0,       end: 20.0,     factor: 0.10 },
  { start: 20.0,      end: Infinity, factor: 0.05 },
];

// ============================================================================
// DATE UTILITIES  (UTC-noon anchor — timezone safe)
// ============================================================================

const DateUtils = {
  format(d) {
    const pad = n => n.toString().padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  },
  today() { return this.format(new Date()); },
  parse(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  },
  addDays(dateStr, days) {
    const d = this.parse(dateStr);
    d.setUTCDate(d.getUTCDate() + days);
    return this.format(d);
  },
  diffDays(a, b) {
    return (this.parse(a).getTime() - this.parse(b).getTime()) / 86_400_000;
  },
  daysSince(ts) { return (Date.now() - ts) / 86_400_000; },
  tsToDate(ts)  { return this.format(new Date(ts)); },
};

// ============================================================================
// MEMORY STATE
// ============================================================================

class MemoryState {
  constructor(stability, difficulty) {
    this.stability  = Math.max(0.001, stability);
    this.difficulty = Math.min(10, Math.max(1, difficulty));
  }
  clone() { return new MemoryState(this.stability, this.difficulty); }
  toJSON() { return { stability: this.stability, difficulty: this.difficulty }; }
  static fromJSON(obj) {
    if (!obj) return null;
    return new MemoryState(obj.stability ?? 0.001, obj.difficulty ?? 5);
  }
}

// ============================================================================
// REVIEW LOG
// ============================================================================

class ReviewLog {
  constructor(data) {
    this.rating         = data.rating;
    this.stability      = data.stability;
    this.difficulty     = data.difficulty;
    this.retrievability = data.retrievability;
    this.elapsedDays    = data.elapsedDays;
    this.pile           = data.pile;
    this.timestamp      = Date.now();
  }
}

// ============================================================================
// FSRS-6 CORE ENGINE  (Corrected — matches py-fsrs exactly)
// ============================================================================

class FSRS6 {
  constructor(params = null) {
    if (params && params.length === 21) {
      this.w = [...params];
    } else {
      if (params) console.warn(`FSRS6: expected 21 params, got ${params.length}. Using defaults.`);
      this.w = [...DEFAULT_FSRS_PARAMS];
    }
    this._initDerived();
  }

  setParams(params) {
    if (!Array.isArray(params) || params.length !== 21)
      throw new Error(`FSRS6.setParams: expected 21 parameters, got ${params?.length}`);
    this.w = [...params];
    this._initDerived();
  }

  _initDerived() {
    // In py-fsrs: _DECAY = -w[20]  (negative),  _FACTOR = 0.9^(1/_DECAY) - 1
    // Equivalent: decay = w[20] (positive),  decayFactor = 0.9^(-1/decay) - 1
    this.decay       = this.w[20];
    this.decayFactor = Math.pow(0.9, -1 / this.decay) - 1;
  }

  // ------------------------------------------------------------------
  // Forgetting curve:  R(t,S) = (1 + decayFactor * t / S) ^ (-decay)
  // Python: (1 + _FACTOR * t / S) ^ _DECAY   (_DECAY is negative there)
  // ------------------------------------------------------------------
  forgettingCurve(t, S) {
    if (t <= 0) return 1.0;
    if (S <= 0) return 0.0;
    return Math.min(0.9999, Math.max(0.0001,
      Math.pow(1 + this.decayFactor * t / S, -this.decay)
    ));
  }

  // ------------------------------------------------------------------
  // Interval helpers
  // ------------------------------------------------------------------

  /** Raw (non-fuzzed) next interval in days. */
  _rawInterval(stability, desiredRetention) {
    const r = Math.min(0.99, Math.max(0.01, desiredRetention));
    const iv = Math.round(
      (stability / this.decayFactor) * (Math.pow(r, -1 / this.decay) - 1)
    );
    return Math.min(SCHEDULER_CONFIG.MAX_INTERVAL, Math.max(SCHEDULER_CONFIG.MIN_INTERVAL, iv));
  }

  /**
   * Additive fuzzing — matches py-fsrs FUZZ_RANGES exactly.
   * For intervals < 2.5 days no fuzz is applied.
   * delta = 1.0 + sum of (factor * overlap with each range)
   * Result is a uniform random integer in [interval-delta, interval+delta].
   */
  _getFuzzedInterval(intervalDays) {
    if (intervalDays < 2.5) return intervalDays;

    let delta = 1.0;
    for (const r of FUZZ_RANGES) {
      delta += r.factor * Math.max(Math.min(intervalDays, r.end) - r.start, 0);
    }

    const minIvl = Math.max(2, Math.round(intervalDays - delta));
    const maxIvl = Math.min(Math.round(intervalDays + delta), SCHEDULER_CONFIG.MAX_INTERVAL);
    const safeMin = Math.min(minIvl, maxIvl);

    // Uniform integer in [safeMin, maxIvl]
    return Math.min(
      Math.floor(Math.random() * (maxIvl - safeMin + 1) + safeMin),
      SCHEDULER_CONFIG.MAX_INTERVAL
    );
  }

  /** Next interval (with optional fuzz). Used during card scheduling. */
  nextInterval(stability, desiredRetention = SCHEDULER_CONFIG.DESIRED_RETENTION) {
    if (stability <= 0) return SCHEDULER_CONFIG.MIN_INTERVAL;
    let iv = this._rawInterval(stability, desiredRetention);
    if (SCHEDULER_CONFIG.ENABLE_FUZZ) iv = this._getFuzzedInterval(iv);
    return iv;
  }

  /** Deterministic interval (no fuzz). Used for button-label previews. */
  nextIntervalDeterministic(stability, desiredRetention = SCHEDULER_CONFIG.DESIRED_RETENTION) {
    if (stability <= 0) return SCHEDULER_CONFIG.MIN_INTERVAL;
    return this._rawInterval(stability, desiredRetention);
  }

  // ------------------------------------------------------------------
  // Initial stability & difficulty  (first review of a new card)
  // ------------------------------------------------------------------

  /** Initial stability for a given rating.  GRADES map 0-3 → w[0]-w[3]. */
  initialStability(rating) {
    return Math.max(0.001, this.w[rating]);
  }

  /**
   * Initial difficulty for a given rating (clamped 1–10).
   * Python: w[4] - exp(w[5] * (rating_1based - 1)) + 1
   */
  initialDifficulty(rating) {
    const g = rating + 1; // GRADES 0-3 → py-fsrs ratings 1-4
    return Math.min(10, Math.max(1, this.w[4] - Math.exp(this.w[5] * (g - 1)) + 1));
  }

  /**
   * Unclamped Easy initial difficulty — used as mean-reversion target.
   * With default params ≈ -4.77 (deliberately left unclamped, matching py-fsrs).
   */
  _easyInitialDifficultyUnclamped() {
    // Easy → g=4, g-1=3
    return this.w[4] - Math.exp(this.w[5] * 3) + 1;
  }

  // ------------------------------------------------------------------
  // Difficulty update  (applied after every review, all ratings)
  // ------------------------------------------------------------------

  /**
   * Python _next_difficulty:
   *   delta  = -w[6] * (rating_1based - 3)
   *   arg2   = oldD + (10 - oldD) * delta / 9   ← NOT clamped before reversion
   *   target = initialDifficulty(Easy, clamp=False)   ← UNCLAMPED (~-4.77)
   *   result = clamp(w[7]*target + (1-w[7])*arg2, 1, 10)
   */
  nextDifficulty(oldD, rating) {
    const g      = rating + 1;                          // 0-3 → 1-4
    const target = this._easyInitialDifficultyUnclamped(); // unclamped!
    const delta  = -this.w[6] * (g - 3);
    const newD   = oldD + delta * (10 - oldD) / 9;     // NOT pre-clamped
    const rev    = this.w[7] * target + (1 - this.w[7]) * newD;
    return Math.min(10, Math.max(1, rev));
  }

  // ------------------------------------------------------------------
  // Stability updates
  // ------------------------------------------------------------------

  /**
   * Short-term stability for same-day reviews (ALL ratings, including Again).
   * Python _short_term_stability:
   *   multiplier = exp(w[17] * (rating_1based - 3 + w[18])) * S^(-w[19])
   *                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^    ^^^^^^^^^^^
   *                         inside exp()                    OUTSIDE exp()!
   *   if Good or Easy: multiplier = max(multiplier, 1.0)
   *   return clamp(S * multiplier, 0.001, ∞)
   */
  shortTermStability(oldS, rating) {
    const g        = rating + 1;
    const expPart  = Math.exp(this.w[17] * (g - 3 + this.w[18]));
    const stabPart = Math.pow(oldS, -this.w[19]);         // OUTSIDE exp
    let multiplier = expPart * stabPart;

    if (rating === GRADES.GOOD || rating === GRADES.EASY) {
      multiplier = Math.max(multiplier, 1.0);
    }
    return Math.max(0.001, oldS * multiplier);
  }

  /**
   * Stability after successful recall (Hard / Good / Easy, elapsedDays ≥ 1).
   * Python _next_recall_stability:
   *   S * (1 + exp(w[8]) * (11-D) * S^(-w[9]) * (exp((1-R)*w[10])-1) * hardPenalty * easyBonus)
   */
  stabilityAfterSuccess(oldS, oldD, retrievability, rating) {
    const hardPenalty = rating === GRADES.HARD ? this.w[15] : 1;
    const easyBonus   = rating === GRADES.EASY ? this.w[16] : 1;
    const multiplier  = 1
      + Math.exp(this.w[8])
      * (11 - oldD)
      * Math.pow(oldS, -this.w[9])
      * (Math.exp((1 - retrievability) * this.w[10]) - 1)
      * hardPenalty
      * easyBonus;
    return Math.max(0.001, oldS * multiplier);
  }

  /**
   * Stability after a lapse (Again, elapsedDays ≥ 1).
   * Python _next_forget_stability:
   *   longTerm  = w[11] * D^(-w[12]) * ((S+1)^w[13] - 1) * exp((1-R)*w[14])
   *   shortTerm = S / exp(w[17] * w[18])
   *   return clamp(min(longTerm, shortTerm), 0.001, ∞)
   */
  stabilityAfterLapse(oldS, oldD, retrievability) {
    const longTerm  = this.w[11]
      * Math.pow(oldD, -this.w[12])
      * (Math.pow(oldS + 1, this.w[13]) - 1)
      * Math.exp((1 - retrievability) * this.w[14]);
    const shortTerm = oldS / Math.exp(this.w[17] * this.w[18]);
    return Math.max(0.001, Math.min(longTerm, shortTerm));
  }

  // ------------------------------------------------------------------
  // Main entry point
  // ------------------------------------------------------------------

  /**
   * Compute the new memory state after a review.
   *
   * Routing matches py-fsrs state machine:
   *   - No prior state        → initial stability & difficulty
   *   - elapsedDays < 1       → shortTermStability (ALL ratings incl. Again)
   *   - elapsedDays ≥ 1 + success → stabilityAfterSuccess
   *   - elapsedDays ≥ 1 + Again  → stabilityAfterLapse
   *
   * @param {MemoryState|null} state
   * @param {number} rating  0=Again 1=Hard 2=Good 3=Easy
   * @param {number} elapsedDays  fractional days since last review
   * @returns {{ newState: MemoryState, retrievability: number }}
   */
  computeNewState(state, rating, elapsedDays = 0) {
    const safeRating  = Math.min(3, Math.max(0, Math.round(rating)));
    const safeElapsed = Math.max(0, elapsedDays);

    // First-ever review of this card
    if (!state) {
      return {
        newState: new MemoryState(
          this.initialStability(safeRating),
          this.initialDifficulty(safeRating)
        ),
        retrievability: 1.0,
      };
    }

    const isSameDay      = safeElapsed < 1;
    const retrievability = this.forgettingCurve(safeElapsed, state.stability);
    let newS;

    if (isSameDay) {
      // Same-day: all ratings (including Again) use short-term formula
      newS = this.shortTermStability(state.stability, safeRating);
    } else if (safeRating !== GRADES.AGAIN) {
      // Different day, success
      newS = this.stabilityAfterSuccess(
        state.stability, state.difficulty, retrievability, safeRating
      );
    } else {
      // Different day, lapse
      newS = this.stabilityAfterLapse(state.stability, state.difficulty, retrievability);
    }

    const newD = this.nextDifficulty(state.difficulty, safeRating);
    return {
      newState: new MemoryState(newS, newD),
      retrievability,
    };
  }

  /** Retrievability as an integer percentage (0–100). */
  getRetrievabilityPercent(state, elapsedDays) {
    if (!state) return 100;
    return Math.round(this.forgettingCurve(elapsedDays, state.stability) * 100);
  }

  /**
   * Deterministic interval predictions for all four grades.
   * Returns { 0: days, 1: days, 2: days, 3: days }.
   */
  getIntervalPredictions(state, elapsedDays = 0) {
    const out = { 0: 1, 1: 1, 2: 1, 3: 4 };
    for (let g = 0; g <= 3; g++) {
      try {
        const { newState } = this.computeNewState(state ? state.clone() : null, g, elapsedDays);
        out[g] = this.nextIntervalDeterministic(newState.stability);
      } catch { /* keep fallback */ }
    }
    return out;
  }
}

// ============================================================================
// CARD FACTORY
// ============================================================================

function fsrsInit(tid) {
  return {
    tid,
    state:          null,
    pile:           PILES.NEW,
    stepIndex:      0,
    nextReviewAt:   null,
    lastReviewedAt: null,
    interval:       0,
    firstSeenAt:    null,
    log:            [],
    ratings:        { again: 0, hard: 0, good: 0, easy: 0 },
  };
}

// ============================================================================
// GLOBAL FSRS INSTANCE
// ============================================================================

let _fsrs = new FSRS6();

function setFSRSParams(params) {
  _fsrs.setParams(params);
  localStorage.setItem('fsrs_params', JSON.stringify(params));
}

function getFSRSParams() { return [..._fsrs.w]; }

function resetFSRSToDefaults() {
  _fsrs = new FSRS6();
  localStorage.removeItem('fsrs_params');
}

function loadSavedFSRSParams() {
  try {
    const saved = localStorage.getItem('fsrs_params');
    if (saved) {
      const params = JSON.parse(saved);
      if (Array.isArray(params) && params.length === 21) {
        _fsrs.setParams(params);
        console.log('[FSRS] Restored saved params');
      }
    }
  } catch (e) {
    localStorage.removeItem('fsrs_params'); // remove invalid params
    console.warn('[FSRS] Could not restore saved params, using defaults');
  }
}

// ============================================================================
// CORE SCHEDULER
// ============================================================================

function updateCard(tid, grade, deck) {
  if (!deck)                                          throw new Error('updateCard: deck required');
  if (typeof tid !== 'string' || !tid)                throw new Error('updateCard: valid tid required');
  if (typeof grade !== 'number' || !isFinite(grade))  throw new TypeError('updateCard: grade must be a number');
  const safeGrade = Math.round(grade);
  if (safeGrade < 0 || safeGrade > 3)                throw new RangeError('updateCard: grade must be 0-3');

  if (!deck[tid]) deck[tid] = fsrsInit(tid);
  const card  = deck[tid];
  const now   = Date.now();
  const today = DateUtils.today();

  if (!card.firstSeenAt) card.firstSeenAt = now;

  let memState = null;
  if (card.state) {
    memState = card.state instanceof MemoryState ? card.state : MemoryState.fromJSON(card.state);
  }

  // For learning/relearning piles the scheduler works in minutes — treat as same-day.
  const inSteps     = card.pile === PILES.NEW || card.pile === PILES.LEARNING || card.pile === PILES.RELEARNING;
  const elapsedDays = !inSteps && card.lastReviewedAt
    ? Math.max(0, (now - card.lastReviewedAt) / 86_400_000)
    : 0;

  const { newState, retrievability } = _fsrs.computeNewState(memState, safeGrade, elapsedDays);
  card.state = newState;

  card.ratings[['again', 'hard', 'good', 'easy'][safeGrade]]++;

  if (!card.log) card.log = [];
  card.log.push(new ReviewLog({
    rating: safeGrade, stability: newState.stability,
    difficulty: newState.difficulty, retrievability, elapsedDays, pile: card.pile,
  }));
  if (card.log.length > SCHEDULER_CONFIG.MAX_LOG_ENTRIES)
    card.log.splice(0, card.log.length - SCHEDULER_CONFIG.MAX_LOG_ENTRIES);

  if (card.pile === PILES.REVIEW) {
    scheduleReviewCard(card, safeGrade, today, now);
  } else {
    scheduleLearningCard(card, safeGrade, today, now);
  }

  card.lastReviewedAt = now;
  if (window.IndexManager?.scheduleRebuild) window.IndexManager.scheduleRebuild();
  return card;
}

// ============================================================================
// LEARNING STEP ENGINE
// ============================================================================

function MINUTES_TO_MS(minutes) { return minutes * 60 * 1000; }

function scheduleLearningCard(card, grade, today, now) {
  const isRelearning = card.pile === PILES.RELEARNING;
  const steps        = isRelearning ? SCHEDULER_CONFIG.RELEARNING_STEPS : SCHEDULER_CONFIG.LEARNING_STEPS;
  card.stepIndex     = Math.min(card.stepIndex, steps.length - 1);

  if (grade === GRADES.EASY) {
    graduate(card, SCHEDULER_CONFIG.EASY_INTERVAL, today, now);
    return;
  }

  if (grade === GRADES.AGAIN) {
    card.pile         = isRelearning ? PILES.RELEARNING : PILES.LEARNING;
    card.stepIndex    = 0;
    card.nextReviewAt = now + MINUTES_TO_MS(steps[0]);
    return;
  }

  const isLastStep = card.stepIndex >= steps.length - 1;

  if (grade === GRADES.HARD) {
    if (isLastStep) {
      const interval = Math.max(
        SCHEDULER_CONFIG.GRADUATING_INTERVAL,
        Math.max(1, Math.floor(_fsrs.nextIntervalDeterministic(card.state.stability) * 0.75))
      );
      graduate(card, interval, today, now);
    } else {
      const currentStep = steps[card.stepIndex];
      const nextStep    = steps[card.stepIndex + 1] || currentStep;
      const hardMins    = Math.round((currentStep + nextStep) / 2);
      card.pile         = isRelearning ? PILES.RELEARNING : PILES.LEARNING;
      card.nextReviewAt = now + MINUTES_TO_MS(hardMins);
    }
    return;
  }

  // GOOD — advance to next step
  card.pile      = isRelearning ? PILES.RELEARNING : PILES.LEARNING;
  card.stepIndex++;
  if (card.stepIndex >= steps.length) {
    graduate(card, Math.max(SCHEDULER_CONFIG.GRADUATING_INTERVAL, _fsrs.nextInterval(card.state.stability)), today, now);
  } else {
    card.nextReviewAt = now + MINUTES_TO_MS(steps[card.stepIndex]);
  }
}

function graduate(card, intervalDays, today, now) {
  card.pile         = PILES.REVIEW;
  card.stepIndex    = 0;
  card.interval     = intervalDays;
  card.nextReviewAt = DateUtils.parse(DateUtils.addDays(today, intervalDays)).getTime();
}

function scheduleReviewCard(card, grade, today, now) {
  if (grade === GRADES.AGAIN) {
    card.pile         = PILES.RELEARNING;
    card.stepIndex    = 0;
    card.nextReviewAt = now + MINUTES_TO_MS(SCHEDULER_CONFIG.RELEARNING_STEPS[0]);
    return;
  }
  const interval    = _fsrs.nextInterval(card.state.stability);
  card.pile         = PILES.REVIEW;
  card.interval     = interval;
  card.nextReviewAt = DateUtils.parse(DateUtils.addDays(today, interval)).getTime();
}

// ============================================================================
// BACKWARD-COMPATIBLE ALIASES
// ============================================================================

function ensureCard(tid) {
  if (typeof state !== 'undefined' && state.sm2) {
    if (!state.sm2[tid]) {
      const topic = state.topics?.find(t => t.id === tid);
      if (topic?.isPastFixed) return fsrsInit(tid);
      state.sm2[tid] = fsrsInit(tid);
    }
    return state.sm2[tid];
  }
  return fsrsInit(tid);
}

const sm2Init   = ensureCard;
const sm2Update = updateCard;

// ============================================================================
// DECK MANAGEMENT
// ============================================================================

function resetCard(tid, deck) {
  if (!deck) throw new Error('resetCard: deck required');
  deck[tid] = fsrsInit(tid);
  return deck[tid];
}

function deleteCard(tid, deck) {
  if (!deck || !deck[tid]) return false;
  delete deck[tid];
  return true;
}

function clearDeck(deck) {
  if (!deck) throw new Error('clearDeck: deck required');
  Object.keys(deck).forEach(key => delete deck[key]);
}

// ============================================================================
// QUERIES
// ============================================================================

function isDueNow(card) {
  if (!card || !card.state || !card.nextReviewAt) return true;
  return card.nextReviewAt <= Date.now();
}

function isDueToday(card) {
  if (!card || !card.state || !card.nextReviewAt) return true;
  return DateUtils.tsToDate(card.nextReviewAt) <= DateUtils.today();
}

function getPile(deck, pile) {
  return deck ? Object.values(deck).filter(c => c.pile === pile) : [];
}

function getFsrsDueCards(deck) {
  if (!deck) return [];
  return Object.values(deck)
    .filter(isDueNow)
    .sort((a, b) => {
      const order = { relearning: 0, learning: 1, new: 2, review: 3 };
      const pa = order[a.pile] ?? 9;
      const pb = order[b.pile] ?? 9;
      return pa !== pb ? pa - pb : (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0);
    });
}

function getRetention(card) {
  if (!card || !card.state) return 100;
  const s = card.state instanceof MemoryState ? card.state : MemoryState.fromJSON(card.state);
  if (!s) return 100;
  return _fsrs.getRetrievabilityPercent(
    s,
    card.lastReviewedAt ? DateUtils.daysSince(card.lastReviewedAt) : 0
  );
}

function getIntervalPredictions(card) {
  if (!card) return { 0: 0, 1: 1, 2: 1, 3: 4 };
  const s           = card.state instanceof MemoryState ? card.state : MemoryState.fromJSON(card.state);
  const elapsedDays = card.lastReviewedAt
    ? Math.max(0, (Date.now() - card.lastReviewedAt) / 86_400_000)
    : 0;
  return _fsrs.getIntervalPredictions(s, elapsedDays);
}

// ============================================================================
// BUTTON LABELS
// ============================================================================

function getButtonLabels(card) {
  const steps   = SCHEDULER_CONFIG.LEARNING_STEPS;
  const fmtMins = m  => m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
  const fmtDays = d  =>
    d < 7   ? `${d}d`
    : d < 30  ? `${Math.round(d / 7)}w`
    : d < 365 ? `${Math.round(d / 30)}mo`
    :           `${Math.round(d / 365)}y`;

  const graduationDays = stability =>
    stability
      ? Math.max(SCHEDULER_CONFIG.GRADUATING_INTERVAL, _fsrs.nextIntervalDeterministic(stability))
      : SCHEDULER_CONFIG.GRADUATING_INTERVAL;

  if (!card || card.pile === PILES.NEW) {
    const hardMins = Math.round((steps[0] + (steps[1] || steps[0])) / 2);
    return {
      again: fmtMins(steps[0]),
      hard:  fmtMins(hardMins),
      good:  steps.length > 1
               ? fmtMins(steps[1])
               : fmtDays(graduationDays(card?.state?.stability)),
      easy:  fmtDays(SCHEDULER_CONFIG.EASY_INTERVAL),
    };
  }

  const isRelearning = card.pile === PILES.RELEARNING;
  const inSteps      = card.pile === PILES.LEARNING || isRelearning;
  const stepSteps    = isRelearning ? SCHEDULER_CONFIG.RELEARNING_STEPS : steps;
  const stepIdx      = card.stepIndex || 0;

  if (inSteps) {
    const clampedIdx  = Math.min(stepIdx, stepSteps.length - 1);
    const isLastStep  = clampedIdx >= stepSteps.length - 1;
    const currentStep = stepSteps[clampedIdx];
    const nextStep    = stepSteps[clampedIdx + 1] || currentStep;
    const stability   = card.state?.stability;

    const hardLabel = isLastStep
      ? fmtDays(Math.max(1, Math.floor((stability ? _fsrs.nextIntervalDeterministic(stability) : 1) * 0.75)))
      : fmtMins(Math.round((currentStep + nextStep) / 2));

    const goodLabel = isLastStep
      ? fmtDays(graduationDays(stability))
      : fmtMins(stepSteps[stepIdx + 1] ?? stepSteps[clampedIdx]);

    return {
      again: fmtMins(stepSteps[0]),
      hard:  hardLabel,
      good:  goodLabel,
      easy:  fmtDays(SCHEDULER_CONFIG.EASY_INTERVAL),
    };
  }

  const preds = getIntervalPredictions(card);
  return {
    again: fmtMins(SCHEDULER_CONFIG.RELEARNING_STEPS[0]),
    hard:  fmtDays(preds[GRADES.HARD]),
    good:  fmtDays(preds[GRADES.GOOD]),
    easy:  fmtDays(preds[GRADES.EASY]),
  };
}

// ============================================================================
// STATISTICS
// ============================================================================

function getDeckStats(deck) {
  if (!deck) return { new: 0, learning: 0, review: 0, relearning: 0, dueNow: 0, dueToday: 0 };
  const cards = Object.values(deck);
  return {
    new:        cards.filter(c => c.pile === PILES.NEW).length,
    learning:   cards.filter(c => c.pile === PILES.LEARNING).length,
    review:     cards.filter(c => c.pile === PILES.REVIEW).length,
    relearning: cards.filter(c => c.pile === PILES.RELEARNING).length,
    dueNow:     cards.filter(isDueNow).length,
    dueToday:   cards.filter(isDueToday).length,
  };
}

// ============================================================================
// GLOBAL ATTACHMENT
// ============================================================================

if (typeof window !== 'undefined') {
  window.FSRS6                  = FSRS6;
  window.MemoryState            = MemoryState;
  window.ReviewLog              = ReviewLog;
  window.GRADES                 = GRADES;
  window.PILES                  = PILES;
  window.DEFAULT_FSRS_PARAMS    = DEFAULT_FSRS_PARAMS;
  window.SCHEDULER_CONFIG       = SCHEDULER_CONFIG;
  window.DateUtils              = DateUtils;
  window.fsrsInit               = fsrsInit;
  window.updateCard             = updateCard;
  window.setFSRSParams          = setFSRSParams;
  window.getFSRSParams          = getFSRSParams;
  window.resetFSRSToDefaults    = resetFSRSToDefaults;
  window.resetCard              = resetCard;
  window.deleteCard             = deleteCard;
  window.clearDeck              = clearDeck;
  window.isDueNow               = isDueNow;
  window.isDueToday             = isDueToday;
  window.getPile                = getPile;
  window.getFsrsDueCards        = getFsrsDueCards;
  window.getRetention           = getRetention;
  window.getIntervalPredictions = getIntervalPredictions;
  window.getButtonLabels        = getButtonLabels;
  window.getDeckStats           = getDeckStats;
  window.ensureCard             = ensureCard;
  window.sm2Init                = sm2Init;
  window.sm2Update              = sm2Update;
  window.setSchedulerConfig     = setSchedulerConfig;
  window.loadSavedFSRSParams = loadSavedFSRSParams;
}
