"""MLB DFS VF2 -- Model configuration. Single source of truth."""

MODEL_VERSION = "vf2_signal_combo_v2"

# === Signal Configuration ===
# 13 signals organized by category (from alpha combination framework).
# Methodology reference: docs/REFERENCES.md — REF-1 (Alpha Combination Framework)
ACTIVE_SIGNALS = [
    # Category 1 - Momentum
    "form_momentum",
    # Category 2 - Mean Reversion
    "salary_implied", "value_gap",
    # Category 3 - Volatility
    "volatility", "ceiling",
    # Category 4 - Factor / Environmental
    "season_stats", "weather",
    # Category 5 - Projection Systems
    "steamer", "batx", "zips", "lgbm_ensemble",
    # Momentum (directional)
    "salary_momentum",
    # Mean Reversion
    "mean_reversion",
]

# Live-only signals (NULL in backtest, added for deployment)
LIVE_SIGNALS = []

# === LightGBM (used as one signal in the stack) ===
LGB_PARAMS = {
    "n_estimators": 100,
    "learning_rate": 0.03,
    "max_depth": 4,
    "num_leaves": 15,
    "min_child_samples": 20,
    "subsample": 0.7,
    "colsample_bytree": 0.7,
    "reg_alpha": 0.5,
    "reg_lambda": 1.0,
    "random_state": 42,
    "verbose": -1,
}

# === Combination Engine ===
COMBINATION_TRAIN_WINDOW = 30  # Use last N dates for weight fitting
COMBINATION_LOOKBACK_DAYS = 30  # Alias for compatibility
MIN_SIGNALS_FOR_COMBINATION = 3

# === Optimizer ===
SALARY_CAP = 50000
ROSTER_SIZE = 10  # DK MLB Classic: 2P + C + 1B + 2B + 3B + SS + 3OF
POSITION_LIMITS = {
    "P": (2, 2),    # exactly 2 pitchers
    "C": (1, 1),
    "1B": (1, 1),
    "2B": (1, 1),
    "3B": (1, 1),
    "SS": (1, 1),
    "OF": (3, 3),
}
MAX_OVERLAP = 7
MAX_EXPOSURE = 0.67
N_LINEUPS = 3
BACKTEST_N_LINEUPS = 3

# === Backtest ===
MIN_TRAIN_DATES = 14
MIN_TEST_DATES = 60
FISHER_P_THRESHOLD = 0.10
N_FIELD_SIMS = 500
BACKTEST_MIN_TRAIN_DATES = 14  # Alias

# === Opponent Simulation ===
OPPONENT_SALARY_ALPHA = 2.0  # Higher = more chalk bias

# === Team Name Mapping ===
TEAM_FULL_TO_ABBR = {
    "Arizona Diamondbacks": "ARI", "Atlanta Braves": "ATL",
    "Baltimore Orioles": "BAL", "Boston Red Sox": "BOS",
    "Chicago Cubs": "CHC", "Chicago White Sox": "CWS",
    "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE",
    "Colorado Rockies": "COL", "Detroit Tigers": "DET",
    "Houston Astros": "HOU", "Kansas City Royals": "KC",
    "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD",
    "Miami Marlins": "MIA", "Milwaukee Brewers": "MIL",
    "Minnesota Twins": "MIN", "New York Mets": "NYM",
    "New York Yankees": "NYY", "Oakland Athletics": "OAK",
    "Philadelphia Phillies": "PHI", "Pittsburgh Pirates": "PIT",
    "San Diego Padres": "SD", "San Francisco Giants": "SF",
    "Seattle Mariners": "SEA", "St. Louis Cardinals": "STL",
    "Tampa Bay Rays": "TB", "Texas Rangers": "TEX",
    "Toronto Blue Jays": "TOR", "Washington Nationals": "WSH",
}
TEAM_ABBR_TO_FULL = {v: k for k, v in TEAM_FULL_TO_ABBR.items()}

# === Cash Engine ===
CASH_VARIANCE_PENALTY = 0.1   # lambda in cash_score = mean - lambda * stdev (H2: 0.1 went 5/5, 0.3 lost 1)
# CLI/script default for cash lineup count. Website passes its own value
# (web/src/app/api/generate/route.ts → user-selectable 1-150).
CASH_N_LINEUPS = 3

# === Sim Pool Filter ===
# Run N optimal lineups with noisy projections to identify robust value plays.
# Players appearing in >= MIN_EXPOSURE% of sims make the pool.
# Noise scale = player's stdev * NOISE_FACTOR (lower = tighter pool, higher = wider).
SIM_POOL_N_SIMS = 100         # number of noisy optimals to run
SIM_POOL_MIN_EXPOSURE = 0.05  # minimum appearance rate (5% = 5/100 sims)
SIM_POOL_NOISE_FACTOR = 0.5   # noise = stdev * this factor (0.5 = moderate perturbation)

# === GPP Engine ===
GPP_LEVERAGE_FACTOR = 0.3     # ownership leverage in GPP scoring
# CLI/script default for GPP lineup count. Website passes its own value
# (web/src/app/api/generate/route.ts → user-selectable 1-150).
GPP_N_LINEUPS = 20
GPP_MAX_EXPOSURE = 0.50       # max single-player exposure across GPP portfolio
GPP_MIN_STACK_SIZE = 3        # minimum batters from same team in a stack
GPP_MAX_BATTER_TEAMS = 2      # max distinct batter teams per lineup

# === GPP Engine v3 (rewrite) ===
# Version tag burned into every portfolio row for provenance.
#
# As of 2026-06-03 this is sourced from the engine registry — the single
# source of truth for "current GPP engine" across the whole system. To
# promote a new version, edit `mlb/configs/engine_registry.py` (one file),
# regenerate the JSON mirror, and restart services. See that file's
# docstring for the procedure.
try:
    from .engine_registry import CURRENT_ENGINE as _CURRENT
    GPP_ENGINE_VERSION = _CURRENT["engine_version"]
except Exception:
    # Fail-safe — preserve the last-known-good value if the registry import
    # breaks during a refactor. The next pipeline run will still write
    # something sensible to mlb_gpp_portfolios.engine_version.
    GPP_ENGINE_VERSION = "MARK_1.1"
# 2026-06-02: MARK_1.1 adds SP+opp-batter HARD constraint at the ILP level.
# All MARK_1.0 components retained:
#   - markowitz λ=1 selector + 0.005 scratch floor + K-adaptive ILP min_diff
#     (5 at K=20, 2 at K=150) + not-in-standings scratch augment + goal=K relax
# NEW in MARK_1.1:
#   - MLB_GPP_BLOCK_SP_OPPBAT=1 default (hard block: max 0 opposing batters
#     allowed in same lineup as a starting pitcher)
#   - Catches the bug project owner observed via Holmes (pitcher + opposing-team
#     batter in single lineup). Structural ρ = -0.24 between SP and opp
#     batter — rostering both wastes variance budget.
# Backtest evidence (N=33 unique paired): K=150 Δ payout +$2.57, McN p=0.34,
# Wilcoxon p=0.049 ✓, bootstrap CI [+$0.54, +$5.13]. K=20 NULL (Wilc p=0.50)
# but doesn't hurt — the constraint only bites occasionally and when it does
# it helps.
# NEVER DEPLOYED LIVE — research anchor only.
# See vault: ~/DFS/vault/03 - SYSTEMS/mlb-gpp-engine-versions.md

# Simulation scale (Phase 6 will activate these)
GPP_N_SLATE_SIMS = 50_000
GPP_N_FIELD_LINEUPS = 10_000

# Leverage formula defaults (Phase 4 tunes these from mlb_gpp_params)
GPP_LAMBDA_DEFAULT = 0.3      # leverage weight on (avg_own - own) / avg_own
GPP_ALPHA_DEFAULT = 0.25      # weight on ceiling upside term (p90 - p50)

# Field-sampler concentration: raises predicted ownership to this power when
# sampling opponent lineups, because the real field is more chalk-concentrated
# than raw projection would suggest. Phase 6.
OWN_CONCENTRATION = 1.5  # 2026-05-26: tested 2.5, regressed; 1.5 is sweet spot

# Portfolio diversity caps (Phase 5 + 7)
MAX_OVERLAP_PLAYERS = 6          # 2026-05-26: tested 4, regressed; 6 is sweet spot
STACK_EXPOSURE_CAP_FRAC = 0.35   # max (stack_type, team, game) share of portfolio
TEAM_EXPOSURE_CAP_FRAC = 0.45    # max lineups stacking any one team
MIN_GAMES_COVERED = 3            # portfolio must touch >= N distinct games

# Per-pitcher portfolio exposure cap (Phase 1a — chalk-SP concentration fix).
# 4/27 backtest: Cease appeared 18/20 (live 16/20). Single-SP failure
# day = 16+ lineups dead. Cap is held FLAT across the relax schedule so
# pitcher concentration can't be widened away when the player/stack/team
# caps relax. None = disabled (backward compat).
# 6-slate walk-forward (4/12-4/19, n=6 main): 0.70/0.80 beat control by
# +4.17pp cash%, +1.67pp top10%, +2.50pp top1% (production-honest, shortfall
# scored as 0). 0.60/0.70 also beat control but underbuilt more (99/120 vs
# 105/120). Graduated 2026-04-28 by project owner.
GPP_MAX_SP_EXPOSURE_FRAC = 0.70  # strict cap (14/20)
GPP_MAX_SP_EXPOSURE_FRAC_RELAXED = 0.80  # ceiling under relaxation (16/20)

# Stack taxonomy (Phase 5)
STACK_TYPES_DEFAULT = ("4-2", "5-3", "3-3-2")
STACK_TYPE_MIN_GAME_TOTAL = {
    "4-2": 8.0,
    "5-3": 9.5,
    "3-3-2": 8.5,
}

# ─── Interview critique refinements (2026-04-17) ────────────────────────
#
# 1) Contest-indexed ceiling-weight multiplier. Base α comes from
#    mlb_gpp_params (learned) or GPP_ALPHA_DEFAULT; we scale it by this
#    multiplier before scoring. Low for cash-style, high for top-heavy
#    where zeros are tolerable and tails win.
CONTEST_ALPHA_MULTIPLIER = {
    "double_up": 0.4,
    "h2h": 0.6,
    "gpp_flat": 1.0,
    "gpp_topheavy": 2.4,  # 2026-05-26: revert from 3.5 (variance over-weighted); 2.4 sweet spot at lambda=0
    "milly_maker": 2.4,
}

# 2) Pitcher leverage multiplier. MLB GPPs concentrate chalk on a handful
#    of starters; pivoting off the top-owned pitcher is the single
#    highest-leverage decision. Multiply the ownership-discount term in
#    leverage_score by this factor for P-position players.
PITCHER_LEVERAGE_MULTIPLIER = 1.3

# 3) Target cumulative predicted ownership per lineup, by contest type.
#    Values are the sum over the 10-slot roster's predicted ownership
#    (fractions 0–1). Lineups whose own-sum exceeds `upper` get penalized;
#    `None` disables the penalty entirely.
#
#    2026-04-18 recalibration: old thresholds (1.2 / 1.5 / 2.0) were derived
#    from a percent-form interview case study and never triggered on real
#    slates — empirical portfolio own_sum medians span 0.00–0.25 on recent
#    backtests (see mlb/data/backtest_gpp/20260417_125929_comparison_...).
#    New thresholds sit just above the recent portfolio distribution so the
#    penalty actually bites on chalk-leaning lineups. Still conservative —
#    a proper sweep via 07b_gpp_learning.py should tune against the
#    CANDIDATE-pool own_sum distribution (75th pct target).
OWN_SUM_BAND = {
    "double_up":    {"upper": None, "weight": 0.0},   # floor-first, no penalty
    "h2h":          {"upper": None, "weight": 0.0},
    "gpp_flat":     {"upper": 0.25, "weight": 0.5},
    "gpp_topheavy": {"upper": 0.20, "weight": 1.0},
    "milly_maker":  {"upper": 0.15, "weight": 1.5},
}

# 4) Portfolio bucket quotas for mode='large' — inspired by the 20-lineup
#    chalk/balanced/contrarian/punt split from sharp-player doctrine.
#    Applied only for top-heavy contest types.
PORTFOLIO_BUCKETS = {
    "chalk_fraction":      0.10,  # 2026-05-26: 0.15→0.10 — chalk caps ceiling
    "balanced_fraction":   0.40,  # 2026-05-26: 0.50→0.40
    "contrarian_fraction": 0.35,  # 2026-05-26: 0.25→0.35 — more diff'd lineups
    "punt_fraction":       0.15,  # 2026-05-26: 0.10→0.15 — more upside dart shots
}

# 5) Batting-order contiguity bonus. Each pair of adjacent primary-stack
#    batters (e.g., orders 2 and 3) scales the stack_score by this
#    additive fraction. A fully-consecutive 4-stack (3 pairs) → +15%.
STACK_CONTIGUITY_BONUS_PER_PAIR = 0.05


# ─── Residual ensemble (Phase 1 — see mlb/docs/2026-04-18-cash-optimizer-signal-edge-design.md) ──

# Ridge alpha grid tried during inner 5-fold CV at training time.
RESIDUAL_RIDGE_ALPHA_GRID = (0.01, 0.1, 1.0, 10.0, 100.0)

# Training aborts below these floors — no synthetic fallbacks.
# 2026-04-18 recalibration: signal snapshots only go back ~1 week (pipeline
# started persisting them on ~2026-04-11), so the date floor was lowered to
# match reality while keeping the sample-size floor high. Player-rows per
# date are ~300, so 6 dates × 300 = 1800 rows — plenty for a 32-feature
# ridge with 5-alpha inner CV. Raise back to 15 once we have 3+ weeks of
# snapshot history accumulated.
RESIDUAL_MIN_TRAINING_DATES = 5           # Min distinct dates with actuals.
RESIDUAL_MIN_ROWS_PER_POSITION = 100      # Min player-date rows per position bucket.

# Salary tier bucket edges (DK $ salary). Players fall into tier i if
# tier_edges[i] <= salary < tier_edges[i+1]. Upper tail open-ended.
RESIDUAL_SALARY_TIER_EDGES = (0, 3000, 4000, 5000, 7000, 1_000_000)
RESIDUAL_SALARY_TIER_LABELS = ("<3k", "3k-4k", "4k-5k", "5k-7k", "7k+")

# Signals included as features (other 9 — rg_fpts is the prior, not a feature).
RESIDUAL_FEATURE_SIGNALS = (
    "dk_fppg", "steamer_ros", "mlb_season_avg", "batcast_season",
    "salary_implied", "propsheet_daily", "solver_projected",
    "market_consensus", "prop_implied",
)

# Promotion gates (shadow → on). All must pass on the rolling evaluation window.
RESIDUAL_PROMOTION_GATES = {
    "rmse_improvement_pct":              0.05,   # ≥5% RMSE improvement vs Karpathy combined
    "spearman_improvement_abs":          0.02,   # ≥0.02 absolute Spearman improvement
    "top30_recall_improvement_abs":      0.03,   # ≥3% top-30 pts/$1k recall improvement
    "max_held_out_rmse_worsening_pct":   0.15,   # no held-out day > 15% worse on RMSE
    "min_held_out_dates":                10,     # min held-out dates for promotion decision
}

# Feature flag env var name. Values: "off" (default), "shadow", "on".
RESIDUAL_FLAG_ENV = "MLB_RESIDUAL_ENSEMBLE"
