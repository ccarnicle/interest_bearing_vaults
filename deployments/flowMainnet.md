# Flow EVM Mainnet Deployment (Aave Pool Integration)

Deployed per `docs/aave_pool_integration_plan.md` Phase 3.

## Addresses

| Contract            | Address |
|---------------------|---------|
| DFSEscrowManager    | `0x97a582e24B6a68a4D654421D46c89B9923F1Fd40` |
| Aave Pool proxy     | `0xbC92aaC2DBBF42215248B5688eB3D3d2b32F2c8d` |
| stgUSDC (underlying)| `0xf1815bd50389c46847f0bda824ec8da914045d14` |
| aStgUSDC (aToken)   | `0x49c6b2799aF2Db7404b930F24471dD961CFE18b7` |

## Verify on FlowScan

DFSEscrowManager has a **no-arg constructor**. Run:

```bash
cd flow_interest_bearing_vaults
npx hardhat verify --network flowMainnet <DFSEscrowManager_ADDRESS>
```

Or use the npm script (pass address after `--`):

```bash
npm run verify:flowMainnet -- <DFSEscrowManager_ADDRESS>
```

FlowScan (BlockScout) accepts any non-empty API key; the config uses `ETHERSCAN_API_KEY` or fallback `flowscan`.

✅ **DFSEscrowManager**: Verified on [FlowScan](https://evm.flowscan.io/address/0x97a582e24B6a68a4D654421D46c89B9923F1Fd40#code)
