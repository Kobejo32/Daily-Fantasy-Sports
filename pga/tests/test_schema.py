from src.signals.schema import SignalRow

def test_signalrow_round_trips_to_dict():
    row = SignalRow(event_id=123, season=2026, source="dg",
                     player="Scottie Scheffler", proj_pts=92.4,
                     pulled_at="2026-05-16T12:00:00Z")
    d = row.to_dict()
    assert d == {
        "event_id": 123, "season": 2026, "source": "dg",
        "player": "Scottie Scheffler", "name_key": "scheffler scottie",
        "proj_pts": 92.4, "pulled_at": "2026-05-16T12:00:00Z",
    }

def test_signalrow_rejects_dk_fields():
    import pytest
    with pytest.raises(ValueError):
        SignalRow(event_id=1, season=2026, source="salary",
                  player="X", proj_pts=1.0, pulled_at="t")
