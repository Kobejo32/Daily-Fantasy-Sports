import numpy as np
from src.signals.engine import blend_player

def test_missing_source_weight_redistributed_proportionally():
    # weights dg=0.6 rg=0.3 pickem=0.1; pickem missing for this player
    weights = {"dg": 0.6, "rg": 0.3, "pickem": 0.1}
    present = {"dg": 100.0, "rg": 50.0}     # pickem absent
    # renormalized: dg 0.6/0.9, rg 0.3/0.9 -> 0.6667*100 + 0.3333*50 = 83.33
    val = blend_player(weights, present)
    assert abs(val - (100*0.6 + 50*0.3) / 0.9) < 1e-6

def test_all_sources_present():
    w = {"dg": 0.5, "rg": 0.5}
    assert blend_player(w, {"dg": 80.0, "rg": 60.0}) == 70.0
