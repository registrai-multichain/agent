# Registrai · Agent

Reference oracle agent for **Registrai**. Today this runs the Warsaw residential real estate index on Arc testnet, attesting daily at 14:00 UTC. The same shape supports any data feed — fork this repo, write your `run()`, deploy.

## What's in here

```
src/
├── sdk/              # Runtime-agnostic SDK — to become @registrai/agent-sdk on npm
│   ├── agent.ts      # defineAgent()
│   ├── chain.ts      # preflight + submitAttestation (viem)
│   ├── compute.ts    # median, trimByPercentile, hashRecords
│   ├── http.ts       # polite fetch with retries
│   └── logger.ts     # structured JSON logs
├── agents/
│   └── warsaw.ts     # the first-party Warsaw resi agent
├── sources/
│   ├── otodom.ts     # Otodom __NEXT_DATA__ parser
│   └── nbp.ts        # NBP anchor fetcher
├── bots/
│   └── trader.ts     # simple market-trading bot for testnet demo activity
├── agents/
│   └── proposer.ts   # LLM market-creator (Anthropic API + heuristic fallback)
├── worker.ts         # Cloudflare Worker entry (cron triggers)
└── index.ts          # Node daemon entry (manual / VPS deploys)
```

## Write an agent in 30 lines

```ts
import { defineAgent, hashRecords, median } from "@registrai/agent-sdk";
import { fetchData } from "./sources/yours";

export default defineAgent({
  name: "your-feed",
  schedule: "0 14 * * *",                // daily 14:00 UTC
  feedId: process.env.FEED_ID!,
  registryAddress: process.env.REGISTRY_ADDRESS!,
  attestationAddress: process.env.ATTESTATION_ADDRESS!,
  methodologyCid: process.env.METHODOLOGY_CID!,
  async run() {
    const inputs = await fetchData();
    const value = Math.round(median(inputs.map(i => i.price)));
    const inputHash = hashRecords(inputs);
    return { value, inputHash };
  },
});
```

The SDK handles preflight (active agent? methodology hash matches? bond ≥ minBond?), simulates the tx, broadcasts, waits for receipt. You bring the data; the SDK does the chain.

## Run

```sh
npm install
cp .env.example .env                # fill in PRIVATE_KEY, RPC_URL, FEED_ID, etc.
npm run dry-run                     # compute the value without attesting
npm run once                        # attest once
npm run dev                         # daemon mode (sleeps until 14:00 UTC daily)
```

## Deploy as a Cloudflare Worker (recommended)

90 seconds, free tier covers it forever:

```sh
npx wrangler login
npx wrangler secret put PRIVATE_KEY
npx wrangler secret put RPC_URL
npx wrangler secret put NBP_REPORT_URL
npx wrangler deploy
```

Cron triggers are configured in [`wrangler.toml`](./wrangler.toml). Add a new feed = add a cron expression + a new agent module + a dispatch line in `worker.ts`.

## Deploy elsewhere

The SDK is runtime-agnostic. Same code runs:

- **Phala Cloud (TEE)** — `npm run build` and `docker push` to a CVM. Key generation via `@phala/dstack-sdk` keeps the agent's signing key inside the enclave.
- **fly.io / Hetzner / Raspberry Pi** — `npm run start` after `npm run build`. Cron via the daemon entry.
- **AWS Lambda + EventBridge** — wrap `runOnce()` in a Lambda handler; trigger via EventBridge cron.

Your call. The protocol only sees the resulting attestations onchain.

## Bot trades

The repo includes a tiny trading bot for seeding demo activity on testnet:

```sh
npm run bot:trade   # one random small trade against the live markets
```

Useful for showing live volume on freshly-created markets.

## License

MIT. See [LICENSE](./LICENSE).
