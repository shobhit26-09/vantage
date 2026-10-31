# Vantage

A public forecasting engine for the real world.

Vantage reads real signals — geopolitical attention, markets and developer ecosystems — and publishes dated, falsifiable
forecasts. Every forecast is graded when its deadline passes. Hits and misses
stay on the public record, and each engine's published probability is
recalibrated against its own track record as outcomes accumulate.

## How it works

- `pipeline/update.mjs` (Node, no dependencies) runs on GitHub Actions every
  6 hours. It fetches free public sources, issues new forecasts where an
  engine has no open position, resolves due forecasts against fresh
  observations using the parameters frozen at issue time, and writes
  `data/forecasts.json` + `data/signals.json`.
- The site is a static bundle (`index.html`, `styles.css`, `app.js`) that
  renders the data files. Deployed on Netlify, auto-published from this repo.

## Engines

| Engine | Forecast | Method |
| --- | --- | --- |
| Markets | 5d realized vol vs median | Empirical regime conditioning, 2y history |
| Tech | Weekly npm downloads momentum | Momentum conditioning, 1y history |
| Geopolitics (attention, not outcomes) | Weekly Wikipedia conflict-topic views | Momentum conditioning, 200d history |

## Honesty rules

- Every forecast states its probability, evidence and resolution rule up front.
- No retroactive edits: ledger entries are append/resolve only.
- "Learning" means published probabilities are recalibrated as outcomes
  accumulate (shrinkage toward the observed hit rate). Logging alone is not
  presented as learning; engines stay labelled `cold-start` until they have
  enough graded outcomes.
- Statistical forecasts, not advice.

## Data sources

Coinbase Exchange · Frankfurter (ECB) · Yahoo Finance · npm · Wikimedia

Built by [Shobhit Gupta](https://github.com/shobhit26-09). Plain JavaScript,
zero build step, free-tier everything.
