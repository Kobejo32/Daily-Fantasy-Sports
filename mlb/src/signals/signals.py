"""
MLB DFS VF2 — Signal Stack (5 categories from alpha combination framework).
Each signal predicts DK points from a DIFFERENT information source.

Categories:
  1. Factor signals: salary, projections, stats (player quality)
  2. Momentum: salary changes, form trends (price/performance movement)
  3. Mean reversion: regression to career baseline (anti-correlated with momentum)
  4. Volatility: player variance profile (cash floor vs GPP ceiling)
  5. Microstructure: ownership/field behavior (who else is picking this player)

Methodology reference: docs/REFERENCES.md — REF-1 (Alpha Combination Framework)
"""
import numpy as np
from .base import BaseSignal
from .batx import BatXSignal
from .zips import ZiPSSignal
from .value_gap import ValueGapSignal
from .ceiling import CeilingSignal
from .weather import WeatherSignal


# ============================================================
# CATEGORY 1: FACTOR SIGNALS (player quality from different sources)
# ============================================================

class SalaryImpliedSignal(BaseSignal):
    """DK salary → DK pts. Source: market consensus pricing."""
    name = "salary_implied"

    def predict(self, date, players, historical):
        bat_sal, bat_pts, pit_sal, pit_pts = [], [], [], []
        for h in historical[-15000:]:
            s, p = h["dk_salary"] / 1000.0, h["dk_points"]
            if h["is_pitcher"]:
                pit_sal.append(s); pit_pts.append(p)
            else:
                bat_sal.append(s); bat_pts.append(p)

        bat_slope, bat_int = np.polyfit(bat_sal, bat_pts, 1) if len(bat_sal) > 20 else (0.5, 3.0)
        pit_slope, pit_int = np.polyfit(pit_sal, pit_pts, 1) if len(pit_sal) > 20 else (1.0, 2.0)

        result = {}
        for p in players:
            sal = p["dk_salary"] / 1000.0
            result[p["player_id"]] = (pit_slope * sal + pit_int) if p["is_pitcher"] else (bat_slope * sal + bat_int)
        return result


class SteamerSignal(BaseSignal):
    """Steamer RoS projection → DK pts/game. Source: statistical projection model."""
    name = "steamer"

    def __init__(self, projections=None):
        self.projections = projections or {}

    def predict(self, date, players, historical):
        all_pts = [h["dk_points"] for h in historical[-3000:]]
        league_avg = float(np.mean(all_pts)) if all_pts else 5.5

        result = {}
        for p in players:
            pid = p["player_id"]
            result[pid] = self.projections.get(pid, league_avg)
        return result


class SeasonStatsSignal(BaseSignal):
    """FanGraphs wOBA/FIP → DK pts. Source: advanced metrics (independent from salary)."""
    name = "season_stats"

    def __init__(self, batter_stats=None, pitcher_stats=None):
        self.batter_stats = batter_stats or {}
        self.pitcher_stats = pitcher_stats or {}

    def predict(self, date, players, historical):
        all_pts = [h["dk_points"] for h in historical[-3000:]]
        league_avg = float(np.mean(all_pts)) if all_pts else 5.5

        result = {}
        for p in players:
            pid = p["player_id"]
            if p["is_pitcher"]:
                stats = self.pitcher_stats.get(pid)
                if stats and stats.get("fip") and stats["fip"] > 0:
                    fip = stats["fip"]
                    k9 = stats.get("k_per_9") or 7.0
                    result[pid] = 3.0 + (k9 - 5.0) * 1.5 + (4.5 - fip) * 2.0
                else:
                    result[pid] = league_avg
            else:
                stats = self.batter_stats.get(pid)
                if stats and stats.get("woba") and stats["woba"] > 0.1:
                    woba = stats["woba"]
                    iso = stats.get("iso") or 0.15
                    result[pid] = woba * 20.0 + iso * 15.0 - 2.0
                else:
                    result[pid] = league_avg
        return result


class LGBMEnsembleSignal(BaseSignal):
    """LightGBM combining all available features. Source: multi-feature ensemble."""
    name = "lgbm_ensemble"

    def __init__(self, steamer_proj=None, batter_stats=None, pitcher_stats=None):
        self.steamer_proj = steamer_proj or {}
        self.batter_stats = batter_stats or {}
        self.pitcher_stats = pitcher_stats or {}

    def predict(self, date, players, historical):
        import lightgbm as lgb

        hist_by_pid = {}
        for h in historical:
            hist_by_pid.setdefault(h["player_id"], []).append((h["date"], h["dk_points"]))

        # Fit salary baselines
        bat_s, bat_p, pit_s, pit_p = [], [], [], []
        for h in historical[-10000:]:
            if h["is_pitcher"]:
                pit_s.append(h["dk_salary"] / 1000.0); pit_p.append(h["dk_points"])
            else:
                bat_s.append(h["dk_salary"] / 1000.0); bat_p.append(h["dk_points"])

        bat_slope, bat_int = np.polyfit(bat_s, bat_p, 1) if len(bat_s) > 20 else (0.5, 3.0)
        pit_slope, pit_int = np.polyfit(pit_s, pit_p, 1) if len(pit_s) > 20 else (1.0, 2.0)

        def _features(player, is_train=False, train_date=None):
            pid = player["player_id"]
            sal = player["dk_salary"] / 1000.0
            is_p = 1.0 if player["is_pitcher"] else 0.0

            hist = hist_by_pid.get(pid, [])
            if is_train and train_date:
                hist = [(d, p) for d, p in hist if d < train_date]

            if hist:
                recent = sorted(hist, reverse=True)[:7]
                form = float(np.mean([p for _, p in recent]))
                stdev = float(np.std([p for _, p in sorted(hist, reverse=True)[:14]])) if len(hist) >= 5 else 4.0
                n_games = len(hist)
            else:
                form, stdev, n_games = sal, 4.0, 0

            if player["is_pitcher"]:
                ps = self.pitcher_stats.get(pid, {})
                stat_val = 1.0 / max(ps.get("fip", 4.2), 1.0) if ps.get("fip") else 0.24
                stat_k = ps.get("k_per_9") or 0
            else:
                bs = self.batter_stats.get(pid, {})
                stat_val = bs.get("woba") or 0
                stat_k = bs.get("iso") or 0

            steamer = self.steamer_proj.get(pid, 0) or 0
            return [sal, is_p, form, stdev, n_games, stat_val, stat_k, steamer]

        # Build training data
        X_train, y_train = [], []
        for h in historical[-6000:]:
            sal = h["dk_salary"] / 1000.0
            baseline = (pit_slope * sal + pit_int) if h["is_pitcher"] else (bat_slope * sal + bat_int)
            feats = _features(h, is_train=True, train_date=h["date"])
            X_train.append(feats)
            y_train.append(h["dk_points"] - baseline)

        if len(X_train) < 200:
            sal_sig = SalaryImpliedSignal()
            return sal_sig.predict(date, players, historical)

        model = lgb.LGBMRegressor(
            n_estimators=100, learning_rate=0.03, max_depth=4, num_leaves=15,
            min_child_samples=20, subsample=0.7, colsample_bytree=0.7,
            reg_alpha=0.5, reg_lambda=1.0, random_state=42, verbose=-1,
        )
        model.fit(np.array(X_train), np.array(y_train))

        result = {}
        for p in players:
            feats = _features(p)
            sal = p["dk_salary"] / 1000.0
            baseline = (pit_slope * sal + pit_int) if p["is_pitcher"] else (bat_slope * sal + bat_int)
            result[p["player_id"]] = baseline + 0.5 * model.predict([feats])[0]
        return result


# ============================================================
# CATEGORY 2: MOMENTUM SIGNALS (direction of change)
# ============================================================

class FormMomentumSignal(BaseSignal):
    """Recent DK pts trend — is the player heating up or cooling down?
    Source: slope of recent performance (independent direction info)."""
    name = "form_momentum"

    def predict(self, date, players, historical):
        by_player = {}
        for h in historical:
            by_player.setdefault(h["player_id"], []).append((h["date"], h["dk_points"]))

        all_pts = [h["dk_points"] for h in historical[-3000:]]
        league_avg = float(np.mean(all_pts)) if all_pts else 5.5

        result = {}
        for p in players:
            pid = p["player_id"]
            hist = by_player.get(pid, [])
            if len(hist) < 5:
                result[pid] = league_avg
                continue
            recent = sorted(hist, reverse=True)[:10]
            pts = [pt for _, pt in reversed(recent)]
            # Linear trend: positive slope = improving
            x = np.arange(len(pts))
            slope = np.polyfit(x, pts, 1)[0]
            # Project forward: last value + slope * 2 games
            result[pid] = pts[-1] + slope * 2
        return result


class SalaryMomentumSignal(BaseSignal):
    """Salary change across dates — market is repricing this player.
    Source: DK salary movement (independent of salary LEVEL).
    Rising salary = market thinks player is underpriced = positive signal."""
    name = "salary_momentum"

    def predict(self, date, players, historical):
        # Build salary history by player
        sal_by_player = {}
        for h in historical:
            sal_by_player.setdefault(h["player_id"], []).append((h["date"], h["dk_salary"]))

        all_pts = [h["dk_points"] for h in historical[-3000:]]
        league_avg = float(np.mean(all_pts)) if all_pts else 5.5

        result = {}
        for p in players:
            pid = p["player_id"]
            hist = sal_by_player.get(pid, [])
            if len(hist) < 3:
                result[pid] = league_avg
                continue

            recent_sals = sorted(hist, reverse=True)[:5]
            sals = [s / 1000.0 for _, s in recent_sals]
            current_sal = p["dk_salary"] / 1000.0

            # Salary change: current vs recent average
            avg_recent = np.mean(sals)
            sal_change = current_sal - avg_recent

            # Convert to DK point prediction: salary change × historical pts/salary ratio
            pts_per_k = league_avg / (np.mean([h["dk_salary"] for h in historical[-3000:]]) / 1000.0)
            result[pid] = league_avg + sal_change * pts_per_k
        return result


# ============================================================
# CATEGORY 3: MEAN REVERSION (regression to baseline)
# ============================================================

class MeanReversionSignal(BaseSignal):
    """Career baseline - recent performance = reversion prediction.
    When form says 'avoid' (scored 2), reversion says 'buy' (career avg is 8).
    ANTI-CORRELATED with momentum — this is the independence required by REF-1
    (Alpha Combination Framework, docs/REFERENCES.md)."""
    name = "mean_reversion"

    def predict(self, date, players, historical):
        by_player = {}
        for h in historical:
            by_player.setdefault(h["player_id"], []).append((h["date"], h["dk_points"]))

        all_pts = [h["dk_points"] for h in historical[-3000:]]
        league_avg = float(np.mean(all_pts)) if all_pts else 5.5

        result = {}
        for p in players:
            pid = p["player_id"]
            hist = by_player.get(pid, [])
            if len(hist) < 10:
                result[pid] = league_avg
                continue

            all_player_pts = [pt for _, pt in hist]
            career_avg = np.mean(all_player_pts)

            recent_7 = sorted(hist, reverse=True)[:7]
            recent_avg = np.mean([pt for _, pt in recent_7])

            # Reversion: blend career avg with weighted recent (60/40)
            # If recent < career → predict UP (reversion). If recent > career → predict DOWN.
            reversion_target = 0.6 * career_avg + 0.4 * recent_avg
            result[pid] = reversion_target
        return result


# ============================================================
# CATEGORY 4: VOLATILITY SIGNALS (variance profile)
# ============================================================

class VolatilitySignal(BaseSignal):
    """Player variance profile — high variance favors GPP, low favors cash.
    Source: coefficient of variation of recent DK points.
    Orthogonal to both salary and form (different dimension of information)."""
    name = "volatility"

    def __init__(self, mode="cash"):
        self.mode = mode  # "cash" penalizes variance, "gpp" rewards it

    def predict(self, date, players, historical):
        by_player = {}
        for h in historical:
            by_player.setdefault(h["player_id"], []).append((h["date"], h["dk_points"]))

        all_pts = [h["dk_points"] for h in historical[-3000:]]
        league_avg = float(np.mean(all_pts)) if all_pts else 5.5
        league_std = float(np.std(all_pts)) if all_pts else 4.0

        result = {}
        for p in players:
            pid = p["player_id"]
            hist = by_player.get(pid, [])
            if len(hist) < 5:
                result[pid] = league_avg
                continue

            pts = [pt for _, pt in sorted(hist, reverse=True)[:14]]
            mean_pts = np.mean(pts)
            std_pts = np.std(pts)

            if self.mode == "cash":
                # Cash: reward consistency (lower variance = bonus)
                consistency_bonus = max(0, (league_std - std_pts) * 0.5)
                result[pid] = mean_pts + consistency_bonus
            else:
                # GPP: reward upside (higher variance = bonus for ceiling)
                ceiling_bonus = max(0, (std_pts - league_std) * 0.5)
                result[pid] = mean_pts + ceiling_bonus + max(pts) * 0.1
        return result


# ============================================================
# FACTORY
# ============================================================

def get_all_backtest_signals(steamer_proj=None, batter_stats=None, pitcher_stats=None,
                              ev_hitter_proj=None, ev_pitcher_proj=None, mode="cash",
                              batx_proj=None, zips_proj=None,
                              quantile_data=None, weather_data=None,
                              exclude_signals=None):
    """Return signals from all 5 backtestable categories.

    Category 1 (Factor):        salary_implied, steamer, season_stats, lgbm_ensemble, weather
    Category 2 (Momentum):      form_momentum, salary_momentum
    Category 3 (Reversion):     mean_reversion, value_gap
    Category 4 (Volatility):    volatility, ceiling
    Category 5 (Projections):   batx, zips

    13 signals from 5 independent categories.

    Args:
        steamer_proj:    dict {player_id: dk_pts_per_game} Steamer projections
        batter_stats:    dict {player_id: stats_dict} batter stats
        pitcher_stats:   dict {player_id: stats_dict} pitcher stats
        ev_hitter_proj:  dict (unused, kept for compatibility)
        ev_pitcher_proj: dict (unused, kept for compatibility)
        mode:            "cash" or "gpp" (affects volatility signal)
        batx_proj:       dict {player_id: dk_pts_per_game} THE BAT X projections
        zips_proj:       dict {player_id: dk_pts_per_game} ZiPS projections
        quantile_data:   dict {player_id: (q50, q90)} for ceiling signal
        weather_data:    dict {date: {team: (wind_out, temp_f, is_roofed)}}
        exclude_signals: set/list of signal names to exclude (e.g. {"lgbm_ensemble"})
    """
    signals = [
        # Category 1: Factor (player quality / environment)
        SalaryImpliedSignal(),
        SteamerSignal(projections=steamer_proj),
        SeasonStatsSignal(batter_stats=batter_stats, pitcher_stats=pitcher_stats),
        LGBMEnsembleSignal(steamer_proj=steamer_proj, batter_stats=batter_stats, pitcher_stats=pitcher_stats),
        WeatherSignal(weather_data=weather_data),
        # Category 2: Momentum (direction)
        FormMomentumSignal(),
        SalaryMomentumSignal(),
        # Category 3: Mean reversion (anti-momentum)
        MeanReversionSignal(),
        ValueGapSignal(batx_proj=batx_proj, steamer_proj=steamer_proj, zips_proj=zips_proj),
        # Category 4: Volatility (variance)
        VolatilitySignal(mode=mode),
        CeilingSignal(quantile_data=quantile_data),
        # Category 5: Projection systems (quasi-microstructure)
        BatXSignal(projections=batx_proj),
        ZiPSSignal(projections=zips_proj),
    ]
    if exclude_signals:
        signals = [s for s in signals if s.name not in exclude_signals]
    return signals
