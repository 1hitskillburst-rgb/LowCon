use crate::memory::models::{MemoryNote, ScoredMemoryNote, ScoringWeights};

/// Calculates recency score using exponential half-life decay: 2^(-age / half_life).
/// At age = 0, score is 1.0. At age = half_life, score is 0.5.
pub fn calculate_recency_score(updated_at: i64, now: i64, half_life_secs: f64) -> f64 {
    if half_life_secs <= 0.0 {
        return 1.0;
    }
    let age_secs = (now - updated_at).max(0) as f64;
    0.5_f64.powf(age_secs / half_life_secs).clamp(0.0, 1.0)
}

/// Computes the individual and composite scores for a candidate note.
/// Returns (final_score, keyword_score, session_score, pin_score, recency_score).
pub fn calculate_score(
    note: &MemoryNote,
    bm25_raw: Option<f64>,
    target_session_id: Option<&str>,
    weights: &ScoringWeights,
    now: i64,
) -> (f64, f64, f64, f64, f64) {
    // 1. Keyword relevance:
    // In SQLite FTS5, bm25() returns negative values where lower/more negative is better match.
    // We normalize the magnitude: magnitude / (1.0 + magnitude)
    let keyword_norm = match bm25_raw {
        Some(bm25) => {
            let magnitude = bm25.abs();
            (magnitude / (1.0 + magnitude)).clamp(0.0, 1.0)
        }
        None => 0.0,
    };
    let keyword_score = keyword_norm * weights.keyword_weight;

    // 2. Session relevance:
    // Current session match: 1.0
    // Global note (session_id is None): 0.5 (general application knowledge)
    // Other session: 0.0
    let session_factor = match (note.session_id.as_deref(), target_session_id) {
        (Some(sid), Some(target)) if sid == target => 1.0,
        (None, _) => 0.5,
        _ => 0.0,
    };
    let session_score = session_factor * weights.session_weight;

    // 3. Pin status:
    let pin_factor = if note.is_pinned { 1.0 } else { 0.0 };
    let pin_score = pin_factor * weights.pinned_weight;

    // 4. Recency:
    let recency_norm = calculate_recency_score(note.updated_at, now, weights.recency_half_life_secs);
    let recency_score = recency_norm * weights.recency_weight;

    let final_score = keyword_score + session_score + pin_score + recency_score;
    (final_score, keyword_score, session_score, pin_score, recency_score)
}

/// Scores and deterministically sorts candidate notes.
/// Pinned notes take precedence, followed by composite score, then recent update, and stable ID tie-breaker.
pub fn rank_and_sort_notes(
    candidates: Vec<(MemoryNote, Option<f64>)>,
    target_session_id: Option<&str>,
    weights: &ScoringWeights,
    now: i64,
) -> Vec<ScoredMemoryNote> {
    let mut scored: Vec<ScoredMemoryNote> = candidates
        .into_iter()
        .map(|(note, bm25)| {
            let (final_score, keyword_score, session_score, pin_score, recency_score) =
                calculate_score(&note, bm25, target_session_id, weights, now);

            let session_match = match (note.session_id.as_deref(), target_session_id) {
                (Some(sid), Some(target)) => sid == target,
                (None, _) => true,
                _ => false,
            };

            let is_pinned = note.is_pinned;

            ScoredMemoryNote {
                note,
                final_score,
                keyword_score,
                session_score,
                pin_score,
                recency_score,
                session_match,
                is_pinned,
                rank: 0,
            }
        })
        .collect();

    // Deterministic sort:
    // 1. is_pinned DESC
    // 2. final_score DESC
    // 3. updated_at DESC
    // 4. id ASC
    scored.sort_by(|a, b| {
        b.is_pinned
            .cmp(&a.is_pinned)
            .then_with(|| {
                b.final_score
                    .partial_cmp(&a.final_score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| b.note.updated_at.cmp(&a.note.updated_at))
            .then_with(|| a.note.id.cmp(&b.note.id))
    });

    for (idx, item) in scored.iter_mut().enumerate() {
        item.rank = idx + 1;
    }

    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_recency_score_decay() {
        let now = 100_000;
        let half_life = 86400.0; // 1 day

        let immediate = calculate_recency_score(now, now, half_life);
        assert!((immediate - 1.0).abs() < 1e-6);

        let one_day_old = calculate_recency_score(now - 86400, now, half_life);
        assert!((one_day_old - 0.5).abs() < 1e-6);

        let two_days_old = calculate_recency_score(now - (2 * 86400), now, half_life);
        assert!((two_days_old - 0.25).abs() < 1e-6);
    }

    #[test]
    fn test_ranking_precedence() {
        let weights = ScoringWeights::default();
        let now = 10_000;

        let mut note_pinned = MemoryNote::new_manual("Pinned Rule", "Keep answers concise", Some("sess-1".into()), true);
        note_pinned.id = "note-pinned".into();

        let mut note_unpinned = MemoryNote::new_manual("Normal Note", "Keep answers concise", Some("sess-1".into()), false);
        note_unpinned.id = "note-unpinned".into();

        let candidates = vec![
            (note_unpinned, Some(-2.0)),
            (note_pinned, Some(-2.0)),
        ];

        let ranked = rank_and_sort_notes(candidates, Some("sess-1"), &weights, now);
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].note.id, "note-pinned");
        assert!(ranked[0].final_score > ranked[1].final_score);
    }
}
