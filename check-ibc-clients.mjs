/**
 * Checks IBC client status for all IBC assets on Osmosis.
 * Identifies assets with expired or frozen IBC clients.
 *
 * Usage: node check-ibc-clients.mjs
 */

const LCD = "https://lcd.osmosis.zone";
const ASSET_LIST_URL =
  "https://raw.githubusercontent.com/osmosis-labs/assetlists/main/osmosis-1/generated/frontend/assetlist.json";

const CONCURRENCY = 5;
const RETRY_DELAY_MS = 1500;
const MAX_RETRIES = 3;

async function fetchJSON(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getClientStatusForChannel(channelId) {
  const channelData = await fetchJSON(
    `${LCD}/ibc/core/channel/v1/channels/${channelId}/ports/transfer`
  );

  const connectionId = channelData.channel?.connection_hops?.[0];
  if (!connectionId) throw new Error(`No connection for ${channelId}`);

  const connData = await fetchJSON(
    `${LCD}/ibc/core/connection/v1/connections/${connectionId}`
  );

  const clientId = connData.connection?.client_id;
  if (!clientId) throw new Error(`No client for ${connectionId}`);

  const statusData = await fetchJSON(
    `${LCD}/ibc/core/client/v1/client_status/${clientId}`
  );

  return {
    channelId,
    connectionId,
    clientId,
    status: statusData.status,
  };
}

async function processInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) await sleep(500);
  }
  return results;
}

async function main() {
  console.log("Fetching asset list from osmosis-labs/assetlists...\n");
  const data = await fetchJSON(ASSET_LIST_URL);

  const ibcAssets = [];

  const assets = Array.isArray(data) ? data.flatMap((g) => g.assets) : data.assets ?? [];
  for (const asset of assets) {
    {
      const ibcMethod = asset.transferMethods?.find((m) => m.type === "ibc");
      if (!ibcMethod) continue;

      const channelId = ibcMethod.chain?.channelId;
      if (!channelId) continue;

      ibcAssets.push({
        symbol: asset.symbol,
        name: asset.name,
        chainName: asset.chainName,
        channelId,
        currentlyUnstable: asset.unstable,
        currentlyDisabled: asset.disabled,
        verified: asset.verified,
      });
    }
  }

  // Deduplicate by channel (multiple assets can share a channel)
  const channelMap = new Map();
  for (const asset of ibcAssets) {
    if (!channelMap.has(asset.channelId)) {
      channelMap.set(asset.channelId, []);
    }
    channelMap.get(asset.channelId).push(asset);
  }

  const uniqueChannels = [...channelMap.keys()];
  console.log(
    `Found ${ibcAssets.length} IBC assets across ${uniqueChannels.length} unique channels.\n`
  );
  console.log("Checking IBC client status for each channel...\n");

  const results = await processInBatches(
    uniqueChannels,
    CONCURRENCY,
    async (channelId) => {
      try {
        const status = await getClientStatusForChannel(channelId);
        return { channelId, ...status, error: null };
      } catch (err) {
        return { channelId, status: "error", error: err.message };
      }
    }
  );

  const expired = [];
  const frozen = [];
  const errors = [];
  const active = [];

  for (const result of results) {
    const assets = channelMap.get(result.channelId);
    const entry = { ...result, assets };

    switch (result.status) {
      case "Expired":
        expired.push(entry);
        break;
      case "Frozen":
        frozen.push(entry);
        break;
      case "Active":
        active.push(entry);
        break;
      default:
        if (result.error) errors.push(entry);
        else expired.push(entry); // unknown status, treat as problematic
    }
  }

  console.log("=".repeat(80));
  console.log(
    `  RESULTS: ${active.length} Active | ${expired.length} Expired | ${frozen.length} Frozen | ${errors.length} Errors`
  );
  console.log("=".repeat(80));

  if (expired.length > 0) {
    console.log("\n🔴 EXPIRED IBC CLIENTS:\n");
    for (const entry of expired) {
      for (const asset of entry.assets) {
        const flags = [];
        if (asset.currentlyUnstable) flags.push("unstable");
        if (asset.currentlyDisabled) flags.push("disabled");
        const flagStr = flags.length
          ? ` [already marked: ${flags.join(", ")}]`
          : " [⚠️  NOT marked unstable/disabled]";
        console.log(
          `  ${asset.symbol.padEnd(12)} ${asset.name.padEnd(30)} chain=${asset.chainName.padEnd(18)} ${entry.channelId.padEnd(16)} client=${entry.clientId ?? "?"} ${flagStr}`
        );
      }
    }
  }

  if (frozen.length > 0) {
    console.log("\n🟡 FROZEN IBC CLIENTS:\n");
    for (const entry of frozen) {
      for (const asset of entry.assets) {
        console.log(
          `  ${asset.symbol.padEnd(12)} ${asset.name.padEnd(30)} chain=${asset.chainName.padEnd(18)} ${entry.channelId.padEnd(16)} client=${entry.clientId ?? "?"}`
        );
      }
    }
  }

  // Highlight expired assets NOT yet marked
  const unmarked = expired.flatMap((e) =>
    e.assets
      .filter((a) => !a.currentlyUnstable && !a.currentlyDisabled)
      .map((a) => ({ ...a, clientId: e.clientId, channelId: e.channelId }))
  );

  if (unmarked.length > 0) {
    console.log("\n" + "=".repeat(80));
    console.log(
      "  ⚠️  ASSETS WITH EXPIRED CLIENT BUT NOT MARKED unstable/disabled:"
    );
    console.log("=".repeat(80) + "\n");
    for (const a of unmarked) {
      console.log(
        `  ${a.symbol.padEnd(12)} ${a.name.padEnd(30)} chain=${a.chainName.padEnd(18)} ${a.channelId}`
      );
    }
    console.log(
      `\n  → These ${unmarked.length} asset(s) should have "osmosis_unstable": true added in`
    );
    console.log("    osmosis-1/osmosis.zone_assets.json in osmosis-labs/assetlists\n");
  }

  if (errors.length > 0) {
    console.log("\n⚪ ERRORS (could not determine status):\n");
    for (const entry of errors) {
      for (const asset of entry.assets) {
        console.log(
          `  ${asset.symbol.padEnd(12)} ${entry.channelId.padEnd(16)} ${entry.error}`
        );
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
