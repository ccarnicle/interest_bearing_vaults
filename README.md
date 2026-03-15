# aiSports Flow EVM Interest-Bearing Escrows

Smart contracts for stablecoin-based DFS contests on **Flow EVM mainnet** with interest-bearing escrow support via **More.Markets (Aave-style Pool)**.

## Hackathon highlights

### Interest-bearing vaults

Contest entry fees are deposited into **Aave-style lending pools** (More.Markets on Flow) instead of sitting idle. While participants compete, funds earn yield. At settlement, principal plus accrued interest is distributed to winners and overflow—no backend required.

### Flow Scheduled Transactions

**Automated investing** — When a contest ends, the contract owner can allowlist a Flow Scheduled Transaction address. That address can call `investEscrowFunds` to move contest funds into the pool and start earning yield automatically.

- No Firebase backend or cron jobs needed
- Scheduled transactions run on Flow natively at the specified time
- Owner adds the scheduled-tx signer via `addInvestEscrowCaller`; organizer and owner can always invest manually

Set `TESTNET_INVEST_CALLER_ADDRESS` at deploy time to allowlist the address that will execute scheduled invests. See [Flow Scheduled Transactions](https://developers.flow.com/blockchain-development-tutorials/forte/scheduled-transactions) for implementation details.

### Cadence contracts for automated escrow investing

This hackathon includes **Flow Cadence** contracts that automate `investEscrowFunds` on `DFSEscrowManager.sol` via cross-VM calls. The Cadence contracts run on Flow mainnet and use the **Flow Transaction Scheduler** to execute daily at a configured time (e.g., 8pm CST).

**How it works:**

1. **DFSEscrowInvestor** — A Cadence contract deployed at `0x254b32edc33e5bc3` (frontend-agent). It borrows the account's Cadence-Owned Account (COA) and:
   - Calls `getActiveEscrowIds()` on the EVM `DFSEscrowManager` to fetch all non-completed escrow IDs
   - For each ID, calls `investEscrowFunds(uint256)` on the EVM contract
   - Skips failures (e.g., escrow not past endTime, already invested) and continues

2. **DFSEscrowInvestorTransactionHandler** — Implements the Flow Transaction Scheduler interface. On each execution it runs `investActiveEscrows()` and reschedules itself for +24 hours.

3. **DFSEscrowManager.sol** — The EVM contract's `investEscrowCallerAllowlist` must include the COA address (`0x0000000000000000000000021ef092c4a124ea6e`). Use `addInvestEscrowCaller` (owner-only) to add it. See `scripts/add_invest_caller_mainnet.ts`.

The Cadence code lives in the `Cadence/` folder of this repo (display-only; deployments are done from the flow-cresendo repo).

**Deployment address (Flow mainnet):** `0x254b32edc33e5bc3` (frontend-agent)

## Current architecture

The primary contract is `contracts/DFSEscrowManager.sol`.

It supports:

- escrow creation by authorized creators
- multi-entry joins (`maxEntriesPerUser`, default `1000`)
- sponsor/organizer pool top-ups via `addToPool`
- optional yield mode per escrow (`pool != address(0)`) and no-yield mode (`pool == address(0)`)
- explicit invest/unwind lifecycle:
  - `investEscrowFunds` (organizer, owner, or allowlisted caller—e.g. Flow Scheduled Tx)
  - `withdrawEscrowFunds`
- payout distribution with overflow routing
- owner-managed pool/token allowlists, invest-caller allowlist, and pause controls

`contracts/DFSEscrowManager_Yearn.sol` is kept as a legacy reference only.

## Flow EVM mainnet integration targets

- **Chain**: Flow EVM Mainnet (`chainId: 747`)
- **Aave-style Pool proxy**: `0xbC92aaC2DBBF42215248B5688eB3D3d2b32F2c8d`
- **stgUSDC (underlying asset)**: `0xf1815bd50389c46847f0bda824ec8da914045d14`
- **aToken (aStgUSDC)**: `0x49c6b2799aF2Db7404b930F24471dD961CFE18b7`

These addresses are documented in `docs/aave_pool_integration_plan.md`.

## Project structure

```text
Cadence/                              # Flow Cadence contracts (hackathon; display-only)
  contracts/
    DFSEscrowInvestor.cdc
    DFSEscrowInvestorTransactionHandler.cdc
  transactions/
    EVM/
      investEscrowOnEvm.cdc
      readActiveEscrowIdsFromEvm.cdc
    EscrowInvestor/
      InitDFSEscrowInvestorTransactionHandler.cdc
      ScheduleDFSEscrowInvestor.cdc
contracts/
  DFSEscrowManager.sol
  DFSEscrowManager_Yearn.sol          # legacy reference
  EscrowManager.sol                   # legacy baseline
  MockToken.sol
  interfaces/
    IPool.sol
    IERC4626.sol
    IVaultFactory.sol
    IYearnVault.sol
  mocks/
    MockAavePool.sol
    MockAToken.sol
    MockVaultFactory.sol
    MockYearnVault.sol
test/
  DFSEscrowManager.ts                 # Phase 1 Aave test strategy implemented
  EscrowManager.ts                    # legacy contract tests
docs/
  aave_pool_integration_plan.md
```

## Setup

```bash
npm install
```

Create `.env`:

```bash
# Used for Flow testnet scripts
DEPLOYER_PRIVATE_KEY=...

# Used for Flow mainnet scripts
MAINNET_PRIVATE_KEY=...

# Optional: verification API key used by Hardhat
ETHERSCAN_API_KEY=...
```

## Common commands

```bash
npm run compile
npm run test
npm run node
```

Run only DFS manager tests:

```bash
npx hardhat test test/DFSEscrowManager.ts
```

## Flow deployment notes

- Deploy target is **Flow EVM mainnet**.
- `DFSEscrowManager` currently has a no-arg constructor.
- After deployment, owner should configure:
  1. `setAllowedPool(<Flow Pool>, true)`
  2. `setAllowedToken(<stgUSDC>, true)`
  3. `setATokenForAsset(<stgUSDC>, <aStgUSDC>)`
  4. `addAuthorizedCreator(<organizer/admin>)`

## Phase 2 Flow testnet scripts

Two scripts implement the Phase 2 testnet plan in `docs/aave_pool_integration_plan.md`:

- `scripts/deploy_dfs_escrow_manager_testnet.ts`
  - Deploys `MockToken`, `MockAavePool`, `MockAToken`, and `DFSEscrowManager`
  - Registers asset/aToken and configures pool/token/aToken allowlists on manager
  - Authorizes organizer (`TESTNET_ORGANIZER_ADDRESS` or deployer by default)
- `scripts/test_flow_testnet_lifecycle.ts`
  - Runs an end-to-end lifecycle on Flow testnet and logs tx hashes for FlowScan
  - Uses already deployed testnet addresses from `.env`
- `scripts/test_flow_testnet_prepare.ts`
  - Prepare script: mint, create escrow, join (no waiting/investing)
  - Prints `TESTNET_ESCROW_ID` for later scripts
- `scripts/test_flow_testnet_prepare_and_invest.ts`
  - Full pre-end script: mint, create escrow, join, wait until endTime, then invest
  - Alternative: use if you want to wait and invest in one go
- `scripts/test_flow_testnet_invest_only.ts`
  - Standalone invest script: checks endTime has passed, then invests
  - Use this if you exited the prepare script early and want to invest later
- `scripts/test_flow_testnet_withdraw_and_distribute.ts`
  - Post-end script: simulate yield, withdraw, distribute, and print expected values for manual verification
  - Uses 4 transactions (mint yield, simulate yield, withdraw, distribute)
- `scripts/test_flow_testnet_settle_combined.ts`
  - Post-end script: simulate yield, then combined withdraw+distribute in one transaction
  - Uses 3 transactions (mint yield, simulate yield, divestAndDistributeWinnings)
  - More gas-efficient option
 
Run:

```bash
npm run deploy:dfs:testnet:phase2
npm run test:flowTestnet:lifecycle
# Recommended 3-step workflow:
npm run test:flowTestnet:prepare      # Create escrow + join
# Wait ~1 hour for endTime to pass
npm run test:flowTestnet:invest       # Invest funds
npm run test:flowTestnet:settle:combined  # Withdraw + distribute (1 tx)

# Alternative workflows:
npm run test:flowTestnet:prepare:full  # Prepare + wait + invest in one script
npm run test:flowTestnet:settle        # Separate withdraw + distribute (2 txs)
```

Required `.env` values for lifecycle script:

```bash
TESTNET_MOCK_TOKEN_ADDRESS=0x...
TESTNET_MOCK_ATOKEN_ADDRESS=0x...
TESTNET_MOCK_AAVE_POOL_ADDRESS=0x...
TESTNET_DFS_ESCROW_MANAGER_ADDRESS=0x...
TESTNET_ESCROW_ID=1
```

Optional `.env` tuning for lifecycle script:

```bash
# Must be >= 3601 (MINIMUM_ESCROW_DURATION is 1 hour)
TESTNET_END_DELAY_SECONDS=3665
TESTNET_DUES_USDC=5
TESTNET_ENTRY_COUNT=1
TESTNET_YIELD_USDC=1
TESTNET_WINNER_PAYOUT_USDC=5
# Address allowed to call investEscrowFunds (e.g., Flow scheduled tx keeper)
# If set at deploy time, added to allowlist; organizer/owner can always invest
TESTNET_INVEST_CALLER_ADDRESS=0x...
```

## License

MIT
