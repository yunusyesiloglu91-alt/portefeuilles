// Indicateurs techniques. Fichier partagé entre Node (backtest) et le navigateur (dashboard).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Indicators = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const nanArray = (n) => new Array(n).fill(NaN);

  function sma(values, n) {
    const out = nanArray(values.length);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(values, n) {
    const out = nanArray(values.length);
    const k = 2 / (n + 1);
    let prev = NaN;
    for (let i = 0; i < values.length; i++) {
      if (i === n - 1) {
        let s = 0;
        for (let j = 0; j < n; j++) s += values[j];
        prev = s / n;
        out[i] = prev;
      } else if (i >= n) {
        prev = values[i] * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  // RSI de Wilder
  function rsi(values, n = 14) {
    const out = nanArray(values.length);
    let gain = 0, loss = 0;
    for (let i = 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      if (i <= n) {
        gain += g; loss += l;
        if (i === n) { gain /= n; loss /= n; }
        else continue;
      } else {
        gain = (gain * (n - 1) + g) / n;
        loss = (loss * (n - 1) + l) / n;
      }
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  function stdev(values, n) {
    const out = nanArray(values.length);
    let sum = 0, sq = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i]; sq += values[i] * values[i];
      if (i >= n) { sum -= values[i - n]; sq -= values[i - n] * values[i - n]; }
      if (i >= n - 1) out[i] = Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
    }
    return out;
  }

  // Plus haut / plus bas glissant sur [i-n+1, i]
  function highest(values, n) {
    const out = nanArray(values.length);
    for (let i = n - 1; i < values.length; i++) {
      let m = -Infinity;
      for (let j = i - n + 1; j <= i; j++) if (values[j] > m) m = values[j];
      out[i] = m;
    }
    return out;
  }

  function lowest(values, n) {
    const out = nanArray(values.length);
    for (let i = n - 1; i < values.length; i++) {
      let m = Infinity;
      for (let j = i - n + 1; j <= i; j++) if (values[j] < m) m = values[j];
      out[i] = m;
    }
    return out;
  }

  // Variation sur n bougies
  function roc(values, n) {
    const out = nanArray(values.length);
    for (let i = n; i < values.length; i++) out[i] = values[i] / values[i - n] - 1;
    return out;
  }

  return { sma, ema, rsi, stdev, highest, lowest, roc };
});
