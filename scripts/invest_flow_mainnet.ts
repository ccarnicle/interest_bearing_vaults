/**
 * Run investEscrowFunds on Flow EVM Mainnet for paid_usdc_4 (or any escrow).
 *
 * Prerequisites:
 *   - MAINNET_PRIVATE_KEY in .env (organizer, owner, or allowlisted caller)
 *   - MAINNET_DFS_ESCROW_MANAGER_ADDRESS in .env
 *   - MAINNET_ESCROW_ID in .env (paid_usdc_4 uses escrow 1 on mainnet; run check_mainnet_escrows.ts to verify)
 *
 * Usage:
 *   npm run invest:flowMainnet
 *   # or: npx hardhat run scripts/invest_flow_mainnet.ts --network flowMainnet
 */

import { ethers, network } from "hardhat";
import type { DFSEscrowManager } from "../typechain-types";

function mustGetEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function flowscanTxUrl(txHash: string): string {
  return `https://evm.flowscan.io/tx/${txHash}`;
}

async function main() {
  if (network.name !== "flowMainnet") {
    throw new Error("This script is intended for --network flowMainnet.");
  }

  const [signer] = await ethers.getSigners();
  const managerAddress = mustGetEnv("MAINNET_DFS_ESCROW_MANAGER_ADDRESS");
  const escrowId = BigInt(mustGetEnv("MAINNET_ESCROW_ID"));

  const manager = (await ethers.getContractAt(
    "DFSEscrowManager",
    managerAddress
  )) as DFSEscrowManager;

  console.log("====================================================");
  console.log("Flow mainnet investEscrowFunds (paid_usdc_4)");
  console.log("====================================================");
  console.log("Caller:", signer.address);
  console.log("Escrow ID:", escrowId.toString());
  console.log("Manager:", managerAddress);

  const details = await manager.getEscrowDetails(escrowId);

  if (details.invested) {
    console.log("\nEscrow is already invested. Nothing to do.");
    console.log("principalInvested:", details.principalInvested.toString());
    return;
  }

  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) {
    throw new Error("Failed to fetch latest block.");
  }
  const now = BigInt(latestBlock.timestamp);

  if (now <= details.endTime) {
    throw new Error(
      `Escrow endTime (${details.endTime.toString()}) has not passed yet. Current time: ${now.toString()}`
    );
  }

  if (details.escrowBalance === 0n) {
    throw new Error("Escrow has zero balance. Nothing to invest.");
  }

  console.log("\nEscrow details:");
  console.log("  endTime:", details.endTime.toString());
  console.log("  current time:", now.toString());
  console.log("  escrowBalance:", details.escrowBalance.toString());
  console.log("  invested:", details.invested);

  const investTx = await manager.investEscrowFunds(escrowId);
  await investTx.wait();
  console.log("\nInvest tx:", investTx.hash, flowscanTxUrl(investTx.hash));

  const detailsAfter = await manager.getEscrowDetails(escrowId);
  console.log("\n====================================================");
  console.log("Invest complete");
  console.log("====================================================");
  console.log("principalInvested:", detailsAfter.principalInvested.toString());
  console.log("escrowBalance:", detailsAfter.escrowBalance.toString());
  console.log("invested:", detailsAfter.invested);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
