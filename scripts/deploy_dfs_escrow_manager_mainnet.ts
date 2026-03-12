/**
 * Deploy DFSEscrowManager to Flow EVM Mainnet (Aave Pool integration).
 * Per docs/aave_pool_integration_plan.md Phase 3.
 *
 * Prerequisites:
 *   - MAINNET_PRIVATE_KEY in .env (deployer with FLOW for gas)
 *
 * Usage:
 *   npm run deploy:dfs:mainnet
 *   # or: npx hardhat run scripts/deploy_dfs_escrow_manager_mainnet.ts --network flowMainnet
 */

import { ethers, network } from "hardhat";

const FLOW_MAINNET_AAVE = {
  pool: "0xbC92aaC2DBBF42215248B5688eB3D3d2b32F2c8d",
  stgUSDC: "0xf1815bd50389c46847f0bda824ec8da914045d14",
  aStgUSDC: "0x49c6b2799aF2Db7404b930F24471dD961CFE18b7",
} as const;

function flowscanTxUrl(txHash: string): string {
  return `https://evm.flowscan.io/tx/${txHash}`;
}

async function main() {
  if (network.name !== "flowMainnet") {
    throw new Error("This script is intended for --network flowMainnet.");
  }

  const [deployer] = await ethers.getSigners();
  const organizerAddress =
    process.env.MAINNET_ORGANIZER_ADDRESS?.trim() || deployer.address;

  console.log("====================================================");
  console.log("Flow EVM Mainnet deployment (Aave Pool)");
  console.log("====================================================");
  console.log("Deployer:", deployer.address);
  console.log("Organizer:", organizerAddress);
  console.log(
    "Balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "FLOW"
  );

  // 1) Deploy DFSEscrowManager (no constructor args)
  const DFSEscrowManager = await ethers.getContractFactory("DFSEscrowManager");
  const dfsEscrowManager = await DFSEscrowManager.deploy();
  await dfsEscrowManager.waitForDeployment();
  const dfsEscrowManagerAddress = await dfsEscrowManager.getAddress();
  const dfsDeployTx = dfsEscrowManager.deploymentTransaction();
  console.log("\nDFSEscrowManager:", dfsEscrowManagerAddress);
  if (dfsDeployTx) {
    console.log("  tx:", dfsDeployTx.hash);
    console.log("  url:", flowscanTxUrl(dfsDeployTx.hash));
  }

  // 2) Configure per aave_pool_integration_plan Phase 3
  const txAllowedPool = await dfsEscrowManager.setAllowedPool(
    FLOW_MAINNET_AAVE.pool,
    true
  );
  await txAllowedPool.wait();

  const txAllowedToken = await dfsEscrowManager.setAllowedToken(
    FLOW_MAINNET_AAVE.stgUSDC,
    true
  );
  await txAllowedToken.wait();

  const txAToken = await dfsEscrowManager.setATokenForAsset(
    FLOW_MAINNET_AAVE.stgUSDC,
    FLOW_MAINNET_AAVE.aStgUSDC
  );
  await txAToken.wait();

  const txCreator = await dfsEscrowManager.addAuthorizedCreator(
    organizerAddress
  );
  await txCreator.wait();

  console.log("\nConfiguration txs:");
  console.log("  setAllowedPool:", txAllowedPool.hash, flowscanTxUrl(txAllowedPool.hash));
  console.log("  setAllowedToken:", txAllowedToken.hash, flowscanTxUrl(txAllowedToken.hash));
  console.log("  setATokenForAsset:", txAToken.hash, flowscanTxUrl(txAToken.hash));
  console.log("  addAuthorizedCreator:", txCreator.hash, flowscanTxUrl(txCreator.hash));

  console.log("\n====================================================");
  console.log("DEPLOYMENT SUMMARY");
  console.log("====================================================");
  console.log("DFSEscrowManager:", dfsEscrowManagerAddress);
  console.log("\nVerify on FlowScan:");
  console.log(`  npx hardhat verify --network flowMainnet ${dfsEscrowManagerAddress}`);
  console.log("\nFor backend .env:");
  console.log(`  EVM_ESCROW_MANAGER_ADDRESS_FLOW_MAINNET=${dfsEscrowManagerAddress}`);
  console.log("====================================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
