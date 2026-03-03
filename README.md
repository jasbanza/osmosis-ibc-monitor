# osmosis-ibc-monitor

Monitors IBC client status for all IBC assets on Osmosis. Identifies assets with expired or frozen IBC clients that may need to be flagged in the [osmosis-labs/assetlists](https://github.com/osmosis-labs/assetlists) repo.

## How it works

The script fetches the Osmosis asset list, extracts all IBC transfer channels, and queries the Osmosis LCD for each channel's client status. It reports:

- **Expired** clients (and whether the asset is already marked `unstable`/`disabled`)
- **Frozen** clients
- Assets with expired clients that are **not yet flagged**

## Usage

```bash
node check-ibc-clients.mjs
```

Requires Node.js 18+ (uses native `fetch`).

## Automated checks

A GitHub Actions workflow runs this check daily at 06:00 UTC. You can also trigger it manually from the Actions tab.
