/**
 * tennis-matcher.ts — never-guess market↔match identity.
 *
 * Adopted pattern (livetennisapi/polymarket-tennis matching.py):
 *   - folded names (case/punctuation-insensitive token sets)
 *   - token-subset + surname similarity scoring
 *   - ±1-day date gate
 *   - best score must exceed a threshold AND beat the runner-up by an
 *     ambiguity margin, else return null — never guess a join.
 *   - explicit override seam for basket whitelisting.
 *
 * A wrong market↔match join silently poisons copy decisions in thin ITF
 * fields where names duplicate/truncate — so returning "unknown" is the
 * correct behavior, not a failure state.
 */

export interface TennisCandidate {
  id: string;
  name: string;
  /** Match date YYYY-MM-DD. Used for the ±1-day gate. */
  date: string;
}

export interface MatchOptions {
  /** Minimum similarity to accept (default 0.70). */
  threshold?: number;
  /** Minimum gap between best and runner-up to disambiguate (default 0.10). */
  ambiguityMargin?: number;
  /** Max calendar days between market date and candidate date (default 1). */
  maxDateDiffDays?: number;
  /** Explicit mapping seam — consulted before any fuzzy matching. */
  override?: (marketName: string) => string | null;
}

/** Fold a name: lowercase, strip non-alpha, collapse whitespace. */
export function foldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(name: string): string[] {
  const folded = foldName(name);
  return folded.length > 0 ? folded.split(' ') : [];
}

/**
 * Token-subset similarity with a surname (last-token) bonus.
 * 1.0 = identical token set; ~0 for disjoint names.
 */
export function nameSimilarity(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.length === 0 || B.length === 0) return 0;
  const [smaller, larger] = A.length <= B.length ? [A, B] : [B, A];
  const setLarger = new Set(larger);
  const overlap = smaller.filter((t) => setLarger.has(t)).length;
  let score = overlap / larger.length;
  // Containment rule: when every token of the smaller set appears verbatim
  // in the larger (e.g. a title "Alcaraz vs TBD" embedding the player name,
  // or a surname-only market vs the full candidate name), the name is present
  // in the title — score it like a match (0.80), not a partial overlap.
  if (overlap === smaller.length) score = Math.max(score, 0.80);
  // Surname rule: tennis titles identify players by surname ("Alcaraz vs
  // TBD", "Djokovic N."), so a surname (last token of either name) appearing
  // verbatim in the other's token set is a strong match signal (0.85) —
  // stronger than a generic token bonus.
  const surnameA = A[A.length - 1];
  const surnameB = B[B.length - 1];
  if (setLarger.has(surnameA) || new Set(smaller).has(surnameB)) {
    score = Math.max(score, 0.85);
  }
  return Math.min(1, score);
}

function dateToDay(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

/**
 * Match a market (name + event date) to the best candidate, or null.
 * Null means: no candidate clears the threshold, OR the top two are too
 * close to call — in both cases the caller must NOT proceed (never guess).
 */
export function matchTennisMarket(
  candidates: TennisCandidate[],
  marketName: string,
  marketDate: string,
  options: MatchOptions = {},
): { id: string; score: number } | null {
  const { threshold = 0.70, ambiguityMargin = 0.10, maxDateDiffDays = 1, override } = options;

  if (override) {
    const forced = override(marketName);
    if (forced) {
      const found = candidates.find((c) => c.id === forced);
      if (found) return { id: found.id, score: 1 };
    }
  }

  const marketDay = dateToDay(marketDate);
  const scored = candidates
    .map((c) => {
      const candidateDay = dateToDay(c.date);
      let dateOk = true;
      if (marketDay !== null && candidateDay !== null) {
        dateOk = Math.abs(marketDay - candidateDay) <= maxDateDiffDays;
      }
      return { id: c.id, score: dateOk ? nameSimilarity(c.name, marketName) : 0 };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  const best = scored[0];
  if (best.score < threshold) return null;
  const runnerUp = scored[1]?.score ?? 0;
  if (best.score - runnerUp <= ambiguityMargin) return null; // ambiguous — never guess
  return { id: best.id, score: best.score };
}