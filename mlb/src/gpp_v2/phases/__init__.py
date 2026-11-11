"""Phase implementations. Each phase consumes-and-returns PortfolioState."""
from mlb.src.gpp_v2.phases.frame import FrameSlate
from mlb.src.gpp_v2.phases.shape import AllocateShape
from mlb.src.gpp_v2.phases.team import SelectTeams
from mlb.src.gpp_v2.phases.stack import ComposeStacks
from mlb.src.gpp_v2.phases.pitcher import PickPitchers
from mlb.src.gpp_v2.phases.fill import LeverageFill
from mlb.src.gpp_v2.phases.sanity import SanityGate
from mlb.src.gpp_v2.phases.select import SelectPortfolio

__all__ = [
    "FrameSlate",
    "AllocateShape",
    "SelectTeams",
    "ComposeStacks",
    "PickPitchers",
    "LeverageFill",
    "SanityGate",
    "SelectPortfolio",
]
