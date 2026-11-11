"""Base signal interface. Every signal produces {player_id: predicted_dk_pts}."""
from abc import ABC, abstractmethod


class BaseSignal(ABC):
    """All signals implement this interface."""

    name: str = "base"

    @abstractmethod
    def predict(self, date, players, historical):
        """
        Predict DK points for each player on a given date.

        Args:
            date: game date string (YYYY-MM-DD)
            players: list of dicts [{player_id, dk_salary, position, is_pitcher, ...}]
            historical: list of dicts [{date, player_id, dk_salary, dk_points, is_pitcher}]
                        ONLY data from dates STRICTLY BEFORE `date` (PIT enforced by caller)

        Returns:
            dict: {player_id: predicted_dk_pts}
        """
        pass
