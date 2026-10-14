# CASCADE public market data

This repository contains only public ECB/CFTC/EIA reference observations and the code needed to validate and calculate CASCADE's published market-data bundle. No private backend, trade inputs, visitor records, credentials or pre-existing Git history are included.

The scheduled workflow attempts updates approximately every six hours (02:23, 08:23, 14:23 and 20:23 UTC). GitHub schedules can be delayed, dropped or disabled; it is not a real-time service or an uptime guarantee. Each source retains its own observation/report date and retrieval time. A failed source keeps its last validated observations with a failure status. Invalid, inconsistent or backwards bundles are not promoted. The website reports fallback/stale data.

Public standard GitHub-hosted runners and static Cloudflare Pages delivery have no new usage charges under their current pricing. The workflow will not run in a private repository or a fork. It uses no paid runners, caches, artifacts, Cloudflare compute, user credentials or custom secrets. Its short-lived repository token is not persisted by checkout; only the publish shell step receives GH_TOKEN.

Sources: [ECB EXR](https://data.ecb.europa.eu/data/datasets/EXR) and [CFTC Commitments of Traders](https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm). Currency futures use TFF Futures Only, Asset Manager and Leveraged Money; gold and WTI oil use Disaggregated Futures Only with Producer/Merchant, Swap Dealer, Managed Money and Other Reportables. Report dates are positions-as-of dates, not publication dates. The histories reflect the latest source vintage, not point-in-time backtest evidence. No profit prediction or trade recommendation is provided.

Run Node 24: npm test; npm run refresh. The public files data/feed.json, data/oil.json and data/commodities.json are individually validated before atomic replacement and published together in a normal, non-force Git commit/push.

## Reliability checks

Official-source network failures and HTTP 408/429/500/502/503/504 responses are retried at most three times with short capped backoff. Invalid data is never retried as if it were a network failure or promoted. Failed sources retain their prior observation and retrieval dates; safe reasons appear in the job logs.

After a validated bundle is published, the refresh job checks each source outcome, observation age and last successful source check. Partial failures make the job fail instead of appearing as a fully successful update. A separate read-only watchdog checks all three public data files and six pages (home, FX checker, position map, gold checker, gold market and oil market) about every six hours, and flags collector/source checks older than 24 hours. Both jobs use only standard public Ubuntu runners, no artifacts, caches, paid services or new secrets.

Workflow failures use GitHub’s normal notification system. The operator must enable Actions notifications and choose email/web delivery in their GitHub notification settings; no email address or external messaging service is configured here. The watchdog also relies on GitHub scheduling and cannot detect a complete GitHub outage while that service is unavailable.

Local check: `node scripts/feed-health.mjs data/feed.json`. Public check: `node scripts/feed-health.mjs --remote`.

## EIA oil data

[data/oil.json](data/oil.json) contains daily physical-market FOB spot prices for [WTI at Cushing](https://www.eia.gov/dnav/pet/hist/RWTCD.htm) and [Europe Brent](https://www.eia.gov/dnav/pet/hist/RBRTED.htm), in USD per barrel. These historical observations are not live prices, CFD quotes or futures prices. The [weekly U.S. commercial crude inventory series](https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=WCESTUS1&f=W) excludes the Strategic Petroleum Reserve (SPR). Its stored unit is thousands of barrels; the website divides by 1,000 to display millions of barrels.

Each series stores observation dates, the EIA publication date, the next scheduled release date, the latest source-check time and the last successful collection time separately. U.S. holidays can shift the weekly publication; consult the [EIA release schedule](https://www.eia.gov/petroleum/supply/weekly/schedule.php). Comparing consecutive available observations can span gaps; comparison dates are always shown. Brent minus WTI is compared only on a common observation date. These data do not establish price causation, forecast prices or compare an inventory release with market consensus.

Oil collection runs after the existing ECB/CFTC collection, on the same approximately six-hour schedule. A failed oil source retains its last validated observations, original publication dates and successful collection time with state `retained`; it does not acquire a fresh observation date. Health checks flag retained series, source checks older than 24 hours, or data past the next scheduled release plus a two-day allowance (and observations older than 21 days). The local and remote health commands validate oil data as well as the existing feed; `feedHealth(bundle)` remains a separate pure ECB/CFTC check. A local oil file defaults to `oil.json` beside the selected feed; an explicit third CLI argument can choose another oil file.

Attribution: U.S. Energy Information Administration (EIA). Follow the [EIA copyright, reuse and attribution policy](https://www.eia.gov/about/copyrights_reuse.php): EIA-produced information is generally public domain and may be reused with source acknowledgment; third-party material can have separate restrictions. Source HTML fixtures are public official inputs retained for deterministic parsing tests, not visitor or account records.

## CFTC gold and WTI participant histories

[data/commodities.json](data/commodities.json) stores the latest 156 weekly reports (about three years) separately for COMEX gold contract 088691 and NYMEX WTI crude oil contract 067651. Both use the official [Disaggregated Futures Only dataset](https://publicreporting.cftc.gov/resource/72hh-3qpy.json), with explicit Futures Only selection and validation of each source record ID, contract, report date and count. The four reported participant groups are Producer/Merchant, Swap Dealer, Managed Money and Other Reportables. Producer/Merchant has no separate spreading field; its stored spreading count is zero. Spreading for the other groups remains separate from directional long and short positions. Reported long plus spreading and short plus spreading totals cannot exceed open interest; nonreportable positions are outside this four-group board.

These dated boards describe weekly positions in contracts, not orders at price levels, executed buy/sell flows, original entry prices or liquidation prices. Weekly changes compare consecutive available reports and expose gaps. Net positions divided by open interest are ranked against at least 52 strictly earlier reports, with ties assigned their midpoint; selected and later reports do not enter that comparison. The latest source vintage is not publication-time backtest data or a price forecast.

Commodity collection runs after the existing feed and EIA oil collectors on the same approximately six-hour workflow. Each asset retains its previous validated history and successful collection timestamp on failure, while recording the attempted check and state `retained`. Writes replace the validated file atomically. Local and remote health checks flag retained data, checks older than 24 hours and report dates older than 12 days, and identify the contract and latest report date. The local commodity file defaults to `commodities.json` beside the selected feed; an explicit fourth CLI argument selects another commodity file. `commodityFeedHealth(bundle)` remains a separate pure check for deterministic fixtures.

The official CFTC and EIA inputs are public and require no API key, account input, paid data service or new secret. This addition uses the existing public runner and static delivery arrangement and adds no paid service. Seed snapshots contain only public source metadata and market observations.
