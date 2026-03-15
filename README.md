# aiSports — Consumer DeFi Daily Fantasy

**aiSports** is a live NBA Daily Fantasy Sports platform on the Flow blockchain. Users draft 5-player rosters, compete on real-world NBA stats, and win crypto prizes. Entry is free or paid via **$JUICE** (our on-chain Flow token) and **stablecoins (USDC)**. The app supports both Flow/Cadence wallets and EVM wallets, with AI-generated NFT collectibles and a full in-game economy.

This repo contains the **hackathon additions** that transform aiSports from a Web3 DFS app into a full Consumer DeFi experience.

---

## Why Consumer DeFi?

Web2 fantasy platforms (FanDuel, DraftKings) are familiar to millions — but they extract value. aiSports meets users where they are: **familiar gameplay, USD entry, and social login** — then unlocks the power of DeFi underneath.

| Web2 DFS | aiSports (Hackathon) |
|---|---|
| Idle entry fees | Entry fees earn yield via Aave |
| Custodial accounts | Social login via Privy (non-custodial) |
| Cron jobs & backends | Flow Scheduled Transactions (native) |
| Fixed prize pools | Prize pools that grow from interest |

Yield funds bigger prizes and supports the protocol — a clear differentiator no centralized site can offer.

---

## Hackathon Deliverables

### 1. EVM Interest-Bearing Escrow — `DFSEscrowManager.sol`

Contest entry fees are deposited into **More.Markets** (Aave-style pool on Flow EVM) instead of sitting idle. While participants compete, funds earn yield. At settlement, principal + accrued interest is distributed to winners — no backend required.

- Supports optional yield mode per escrow (`pool != address(0)`)
- Explicit invest/unwind lifecycle: `investEscrowFunds` → `withdrawEscrowFunds` → `divestAndDistributeWinnings`
- Owner-managed pool/token allowlists and pause controls

**Flow EVM Mainnet targets:**
| | Address |
|---|---|
| Chain | Flow EVM Mainnet (`chainId: 747`) |
| DFSEscrowManager | `0x97a582e24B6a68a4D654421D46c89B9923F1Fd40` |
| Aave Pool Proxy | `0xbC92aaC2DBBF42215248B5688eB3D3d2b32F2c8d` |
| stgUSDC (asset) | `0xf1815bd50389c46847f0bda824ec8da914045d14` |
| aStgUSDC (aToken) | `0x49c6b2799aF2Db7404b930F24471dD961CFE18b7` |

### 2. Stablecoin Entry

Contest entry fees denominated in **USDC** — lowering the barrier for users unfamiliar with native crypto tokens. USD-familiar entry is key to the consumer onboarding story.

### 3. Flow Scheduled Transactions (Automated Investing)

No cron jobs. No Firebase. **Flow's native transaction scheduler** automates `investEscrowFunds` daily.

- **`DFSEscrowInvestor`** (Cadence) — borrowing the account's COA, calls `getActiveEscrowIds()` on the EVM contract and invests each eligible escrow.
- **`DFSEscrowInvestorTransactionHandler`** — implements Flow's scheduler interface; executes and reschedules itself every 24 hours.
- Deployed at `0x254b32edc33e5bc3` (Flow mainnet)
- COA allowlisted via `addInvestEscrowCaller` on `DFSEscrowManager`

### 4. Social Login via Privy

Privy integration enables **email and social logins** — users get a non-custodial EVM wallet provisioned automatically. No seed phrases, no friction. This is the consumer on-ramp that bridges Web2 players into Web3 DeFi contests.

---

## Existing Platform (aiSports)

- **NBA DFS Contests** — free and paid daily fantays contest
- **$JUICE Token** — on-chain Flow token for premium contest entry and NFT purchases
- **AI-Generated NFTs** — unique collectibles using Stable Diffusion, purchasable with Juice
- **Dual Wallet Support** — Flow/Cadence wallets and Dapper wallets
- **AI Player Salaries** — Vertex AI calculates predictive fantasy scores per player
- **Firebase Backend** — user profiles, in-game Juice balances, real-time contest data

---

## Project Structure

```text
Cadence/
  contracts/
    DFSEscrowInvestor.cdc
    DFSEscrowInvestorTransactionHandler.cdc
  transactions/
    EVM/investEscrowOnEvm.cdc
    EscrowInvestor/InitDFSEscrowInvestorTransactionHandler.cdc
contracts/
  DFSEscrowManager.sol          # Primary hackathon contract
  DFSEscrowManager_Yearn.sol    # Legacy reference
  interfaces/  mocks/
scripts/
  deploy_dfs_escrow_manager_testnet.ts
  test_flow_testnet_lifecycle.ts
  add_invest_caller_mainnet.ts
test/
  DFSEscrowManager.ts
docs/
  aave_pool_integration_plan.md
```

---

## Setup

```bash
npm install
```

Create `.env`:

```bash
DEPLOYER_PRIVATE_KEY=...
MAINNET_PRIVATE_KEY=...
ETHERSCAN_API_KEY=...         # optional, for verification
```

```bash
npm run compile
npm run test
npx hardhat test test/DFSEscrowManager.ts
```

## Mainnet Post-Deploy Config

```bash
setAllowedPool(<Flow Pool>, true)
setAllowedToken(<stgUSDC>, true)
setATokenForAsset(<stgUSDC>, <aStgUSDC>)
addAuthorizedCreator(<organizer>)
addInvestEscrowCaller(<COA address>)    # allow scheduled tx to invest
```

## Testnet Workflow

```bash
npm run deploy:dfs:testnet:phase2
npm run test:flowTestnet:prepare        # create escrow + join
# wait ~1 hour
npm run test:flowTestnet:invest         # invest into pool
npm run test:flowTestnet:settle:combined  # withdraw + distribute
```

---

## License

MIT
