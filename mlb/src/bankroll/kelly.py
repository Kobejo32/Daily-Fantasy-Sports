"""
Empirical Kelly criterion for DFS bankroll sizing.
f_empirical = f_kelly × (1 - CV_edge)
"""
import numpy as np


def compute_kelly_fraction(cash_probability, payout_mult=1.8, cv_edge=0.5):
    """
    Compute empirical Kelly fraction for a DFS contest.

    Args:
        cash_probability: estimated P(cashing) from Monte Carlo simulation
        payout_mult: contest payout multiplier (1.8 for 50/50, 2.0 for double-up)
        cv_edge: coefficient of variation of edge estimate (0-1, higher = less certain)

    Returns:
        float: fraction of bankroll to risk (0-1)
    """
    p = cash_probability
    q = 1 - p
    b = payout_mult

    # Standard Kelly
    if b <= 0 or p <= 0:
        return 0.0

    f_kelly = (p * b - q) / b

    # If negative edge, don't bet
    if f_kelly <= 0:
        return 0.0

    # Empirical adjustment: reduce by uncertainty
    f_empirical = f_kelly * (1 - cv_edge)

    # Safety caps
    f_empirical = min(f_empirical, 0.10)  # Never risk more than 10% of bankroll per slate
    f_empirical = max(f_empirical, 0.0)

    return f_empirical


def compute_slate_allocation(bankroll, portfolio_cash_prob, n_entries=3,
                              entry_fee=1.0, payout_mult=1.8, cv_edge=0.5):
    """
    Compute how much to allocate to a slate.

    Args:
        bankroll: current bankroll ($)
        portfolio_cash_prob: P(at least one lineup cashes) from Monte Carlo
        n_entries: number of lineups to enter
        entry_fee: per-entry fee ($)
        payout_mult: contest payout
        cv_edge: uncertainty in edge estimate

    Returns:
        dict with allocation details
    """
    kelly_f = compute_kelly_fraction(portfolio_cash_prob, payout_mult, cv_edge)
    total_risk = bankroll * kelly_f
    per_entry = entry_fee
    max_entries = int(total_risk / per_entry) if per_entry > 0 else 0
    actual_entries = min(n_entries, max_entries)
    actual_risk = actual_entries * per_entry

    return {
        "kelly_fraction": kelly_f,
        "total_risk_budget": round(total_risk, 2),
        "recommended_entries": actual_entries,
        "total_cost": round(actual_risk, 2),
        "portfolio_cash_prob": portfolio_cash_prob,
        "expected_payout": round(actual_entries * per_entry * payout_mult * portfolio_cash_prob, 2),
        "expected_profit": round(actual_entries * per_entry * (payout_mult * portfolio_cash_prob - 1), 2),
    }
