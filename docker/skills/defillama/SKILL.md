---
name: defillama
description: DeFi data from DefiLlama's free public API (no key) - protocol and chain TVL, token prices and charts, stablecoins, yield pools, DEX volume, fees and revenue, open interest, hacks. Use for DeFi research, protocol due diligence, yield screening and market context before a trade.
---

# DefiLlama (free public API)

Read-only HTTP GET, no API key, no MCP. Fetch with Python (`jq` is not installed). Some responses are 5-10 MB:
always filter in the same script and print only the rows you need; never dump a full response into the conversation.

```python
import requests
r = requests.get("https://api.llama.fi/protocols", timeout=60); r.raise_for_status()
# category "CEX" rows are exchange reserves, not DeFi: drop them unless asked
rows = sorted((p for p in r.json() if "Near" in p.get("chains", []) and p.get("category") != "CEX"), key=lambda p: -(p.get("tvl") or 0))
for p in rows[:10]: print(p["slug"], p["name"], round(p["tvl"] or 0), p.get("change_1d"))
```

## Endpoints (checked free on 2026-11-08)

| Need | GET | Notes |
|---|---|---|
| All protocols | `https://api.llama.fi/protocols` | ~10 MB. `slug`, `name`, `category`, `chains`, `tvl`, `change_1d/7d`, `mcap` |
| One protocol | `https://api.llama.fi/protocol/{slug}` | ~10 MB with history. `currentChainTvls`, `tvl` (history), `tokens` |
| Current TVL only | `https://api.llama.fi/tvl/{slug}` | a single number |
| Chains | `https://api.llama.fi/v2/chains` | `name`, `tvl`, `tokenSymbol`, `gecko_id` |
| Chain TVL history | `https://api.llama.fi/v2/historicalChainTvl/{Chain}` | chain name as in /v2/chains, e.g. `Near`, `Solana` |
| Token prices | `https://coins.llama.fi/prices/current/{coins}` | comma list of `coingecko:{id}` or `{chain}:{address}`, e.g. `coingecko:near,ethereum:0xa0b8...` |
| Price chart | `https://coins.llama.fi/chart/{coins}?span=30&period=1d` | |
| Price change | `https://coins.llama.fi/percentage/{coins}` | 24h change by default |
| Stablecoins | `https://stablecoins.llama.fi/stablecoins?includePrices=true` | `peggedAssets[]`: supply per chain, peg price |
| Stablecoins by chain | `https://stablecoins.llama.fi/stablecoinchains` | |
| Yield pools | `https://yields.llama.fi/pools` | ~10 MB, `data[]`: `chain`, `project`, `symbol`, `tvlUsd`, `apy`, `apyBase`, `apyReward`, `stablecoin`, `ilRisk`, `pool` |
| DEX volume | `https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true` | `protocols[]`: `total24h`, `total7d`, `change_1d` |
| Fees / revenue | `https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true` | add `&dataType=dailyRevenue` for revenue |
| One protocol's fees | `https://api.llama.fi/summary/fees/{slug}?dataType=dailyFees` | e.g. `hyperliquid` |
| Open interest | `https://api.llama.fi/overview/open-interest?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true` | perps OI by protocol |
| Hacks | `https://api.llama.fi/hacks` | `date`, `name`, `classification`, `technique`, `amount`, `chain` |

**Paid only** (HTTP 402 "Upgrade to the paid API plan"): derivatives volume, bridges, raises, emissions/unlocks. Do not
retry them; say the data needs a DefiLlama plan and use another source.

## How to read the numbers

- TVL is a stock (value locked now); volume, fees and revenue are flows (per period). Do not compare one with the other.
- Fees are what users pay; revenue is the part the protocol keeps. P/F and P/S = market cap / annualised fees or revenue.
- High `apy` with large `apyReward` and small `tvlUsd` is incentive-driven and fragile; prefer `apyBase`, check `ilRisk`
  and pool size against the position you intend to take.
- A protocol in `/hacks` is a risk flag; note the date and technique.
- Always state the timestamp of the data you used.
