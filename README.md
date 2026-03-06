# aiSports Flow EVM Interest-Bearing Escrows

Smart contracts for stablecoin-based DFS contests on **Flow EVM mainnet** with interest-bearing escrow support via **More.Markets (Aave-style Pool)**.

## Current architecture

The primary contract is `contracts/DFSEscrowManager.sol`.

It supports:

- escrow creation by authorized creators
- multi-entry joins (`maxEntriesPerUser`, default `1000`)
- sponsor/organizer pool top-ups via `addToPool`
- optional yield mode per escrow (`pool != address(0)`) and no-yield mode (`pool == address(0)`)
- explicit invest/unwind lifecycle:
  - `investEscrowFunds`
  - `withdrawEscrowFunds`
- payout distribution with overflow routing
- owner-managed pool/token allowlists and pause controls

`contracts/DFSEscrowManager_Yearn.sol` is kept as a legacy reference only.

## Flow EVM mainnet integration targets

- **Chain**: Flow EVM Mainnet (`chainId: 747`)
- **Aave-style Pool proxy**: `0xbC92aaC2DBBF42215248B5688eB3D3d2b32F2c8d`
- **stgUSDC (underlying asset)**: `0xf1815bd50389c46847f0bda824ec8da914045d14`
- **aToken (aStgUSDC)**: `0x49c6b2799aF2Db7404b930F24471dD961CFE18b7`

These addresses are documented in `docs/aave_pool_integration_plan.md`.

## Project structure

```text
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

## License

MIT
