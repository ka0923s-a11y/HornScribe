"""Shared exact-numeric helpers for the rhythm contracts layer."""

from __future__ import annotations

from fractions import Fraction


def as_exact_fraction(value: Fraction | int, *, name: str) -> Fraction:
    """Return *value* as an exact :class:`~fractions.Fraction`.

    ``Fraction`` and ``int`` inputs are already exact. Everything else —
    notably ``float`` — is rejected so binary floating-point error can never
    leak into symbolic score positions (issue #15: "meter positions use exact
    Fraction where symbolic").
    """
    if isinstance(value, Fraction):
        return value
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(
            f"{name} must be an exact Fraction (got {type(value).__name__} {value!r})"
        )
    return Fraction(value)
