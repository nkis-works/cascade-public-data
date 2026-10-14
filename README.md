# CASCADE public market data

This repository contains only public ECB/CFTC reference observations and the code needed to validate and calculate CASCADE's published market-data bundle. No private backend, trade inputs, visitor records, credentials or pre-existing Git history are included.

The scheduled workflow attempts updates approximately every six hours (02:23, 08:23, 14:23 and 20:23 UTC). GitHub schedules can be delayed, dropped or disabled; it is not a real-time service or an uptime guarantee. Each source retains its own observation/report date and retrieval time. A failed source keeps its last validated observations with a failure status. Invalid, inconsistent or backwards bundles are not promoted. The website reports fallback/stale data.

Public standard GitHub-hosted runners and static Cloudflare Pages delivery have no new usage charges under their current pricing. The workflow will not run in a private repository or a fork. It uses no paid runners, caches, artifacts, Cloudflare compute, user credentials or custom secrets. Its short-lived repository token is not persisted by checkout; only the publish shell step receives GH_TOKEN.

Sources: [ECB EXR](https://data.ecb.europa.eu/data/datasets/EXR) and [CFTC Commitments of Traders](https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm). Currency futures use TFF Futures Only, Asset Manager and Leveraged Money; gold uses Disaggregated Futures Only, Managed Money. Report dates are positions-as-of dates, not publication dates. The histories reflect the latest source vintage, not point-in-time backtest evidence. No profit prediction or trade recommendation is provided.

Run Node 24: npm test; npm run refresh. The one public file data/feed.json is validated before atomic replacement and a normal, non-force Git commit/push.

## Reliability checks

Official-source network failures and HTTP 408/429/500/502/503/504 responses are retried at most three times with short capped backoff. Invalid data is never retried as if it were a network failure or promoted. Failed sources retain their prior observation and retrieval dates; safe reasons appear in the job logs.

After a validated bundle is published, the refresh job checks each source outcome, observation age and last successful source check. Partial failures make the job fail instead of appearing as a fully successful update. A separate read-only watchdog checks the public feed and three main pages about every six hours, and flags collector/source checks older than 24 hours. Both jobs use only standard public Ubuntu runners, no artifacts, caches, paid services or new secrets.

Workflow failures use GitHub’s normal notification system. The operator must enable Actions notifications and choose email/web delivery in their GitHub notification settings; no email address or external messaging service is configured here. The watchdog also relies on GitHub scheduling and cannot detect a complete GitHub outage while that service is unavailable.

Local check: `node scripts/feed-health.mjs data/feed.json`. Public check: `node scripts/feed-health.mjs --remote`.
