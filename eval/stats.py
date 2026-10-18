"""Small statistics for the evaluation: percentile bootstrap CIs, percentiles, Cohen's kappa, confusion matrices and a
prediction-powered (PPI) mean. Pure Python and seeded, so the same rows always give the same intervals."""
from __future__ import annotations

import math
import random
from collections.abc import Callable, Sequence

N_BOOT = 2000
ALPHA = 0.05
SEED = 7


def _numbers(values) -> list[float]:
    return [float(v) for v in values if v is not None]


def percentile(values, q: float) -> float | None:
    """Linear-interpolated percentile (q in 0–100) of the values that are not None."""
    xs = sorted(_numbers(values))
    if not xs:
        return None
    k = (len(xs) - 1) * q / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def bootstrap(items: Sequence, stat: Callable[[Sequence], float | None], n_boot: int = N_BOOT, alpha: float = ALPHA,
              seed: int = SEED) -> tuple[float, float] | None:
    """Percentile bootstrap CI of `stat` over `items` (resampled with replacement, one item = one case)."""
    items = list(items)
    if not items:
        return None
    rng = random.Random(seed)
    stats = []
    for _ in range(n_boot):
        value = stat([items[rng.randrange(len(items))] for _ in items])
        if value is not None:
            stats.append(value)
    if not stats:
        return None
    return percentile(stats, 100 * alpha / 2), percentile(stats, 100 * (1 - alpha / 2))


def mean(values) -> float | None:
    xs = _numbers(values)
    return sum(xs) / len(xs) if xs else None


def mean_ci(values, **kw) -> tuple[float, float] | None:
    """95 % CI of the mean of a case-level metric (booleans count as 0/1; None = not applicable, left out)."""
    return bootstrap(_numbers(values), mean, **kw)


def pooled_share_ci(pairs: Sequence[tuple[float, float]], **kw) -> tuple[float, float] | None:
    """CI of sum(hits) / sum(totals) with cases resampled as clusters (pairs = (hits, total) per case)."""
    pairs = [(float(h), float(t)) for h, t in pairs if t]

    def share(sample):
        total = sum(t for _, t in sample)
        return sum(h for h, _ in sample) / total if total else None

    return bootstrap(pairs, share, **kw)


# ---------------------------------------------------------------- agreement

def confusion(truth: Sequence[str], predicted: Sequence[str], labels: Sequence[str]) -> list[list[int]]:
    """Counts with rows = truth (expert) and columns = predicted (judge), in `labels` order."""
    index = {label: i for i, label in enumerate(labels)}
    matrix = [[0] * len(labels) for _ in labels]
    for t, p in zip(truth, predicted, strict=True):
        if t in index and p in index:
            matrix[index[t]][index[p]] += 1
    return matrix


def cohen_kappa(truth: Sequence[str], predicted: Sequence[str], labels: Sequence[str],
                weights: str | None = None) -> float | None:
    """Cohen's kappa; `weights="linear"` treats the labels as ordered (supported > partial > unsupported)."""
    m = confusion(truth, predicted, labels)
    n, k = sum(map(sum, m)), len(labels)
    if not n:
        return None
    rows = [sum(r) for r in m]
    cols = [sum(m[i][j] for i in range(k)) for j in range(k)]

    def w(i: int, j: int) -> float:
        if weights == "linear":
            return abs(i - j) / (k - 1) if k > 1 else 0.0
        return 0.0 if i == j else 1.0

    observed = sum(w(i, j) * m[i][j] for i in range(k) for j in range(k)) / n
    expected = sum(w(i, j) * rows[i] * cols[j] for i in range(k) for j in range(k)) / (n * n)
    if expected == 0:
        return 1.0 if observed == 0 else None
    return 1.0 - observed / expected


def accuracy(truth: Sequence[str], predicted: Sequence[str]) -> float | None:
    pairs = list(zip(truth, predicted, strict=True))
    return sum(1 for t, p in pairs if t == p) / len(pairs) if pairs else None


def balanced_accuracy(truth: Sequence[str], predicted: Sequence[str], labels: Sequence[str]) -> float | None:
    """Mean recall over the labels that occur in `truth`."""
    recalls = []
    for label in labels:
        idx = [i for i, t in enumerate(truth) if t == label]
        if idx:
            recalls.append(sum(1 for i in idx if predicted[i] == label) / len(idx))
    return sum(recalls) / len(recalls) if recalls else None


def ppi_mean(unlabelled_pred: Sequence[float], labelled_pred: Sequence[float], labelled_true: Sequence[float],
             z: float = 1.96) -> tuple[float, float, float] | None:
    """Prediction-powered estimate of a rate (Angelopoulos et al. 2023; the rectifier ARES uses): the judge's rate on
    many unlabelled sentences, corrected by the judge's error on the expert-labelled ones. (estimate, low, high)."""
    if not labelled_pred or len(labelled_pred) != len(labelled_true):
        return None
    unl = list(unlabelled_pred) or list(labelled_pred)
    rect = [p - t for p, t in zip(labelled_pred, labelled_true, strict=True)]
    est = sum(unl) / len(unl) - sum(rect) / len(rect)

    def var(xs):
        mu = sum(xs) / len(xs)
        return sum((x - mu) ** 2 for x in xs) / (len(xs) - 1) if len(xs) > 1 else 0.0

    half = z * math.sqrt(var(unl) / len(unl) + var(rect) / len(rect))
    return est, est - half, est + half
