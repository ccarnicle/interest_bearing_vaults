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
  return `https://evm-testnet.flowscan.io/tx/${txHash}`;
}

async function main() {
  if (network.name !== "flowTestnet") {
    throw new Error("This script is intended for --network flowTestnet.");
  }

  const [organizer] = await ethers.getSigners();
  const managerAddress = mustGetEnv("TESTNET_DFS_ESCROW_MANAGER_ADDRESS");
  const escrowId = BigInt(mustGetEnv("TESTNET_ESCROW_ID"));

  const manager = (await ethers.getContractAt(
    "DFSEscrowManager",
    managerAddress
  )) as DFSEscrowManager;

  console.log("====================================================");
  console.log("Flow testnet invest only");
  console.log("====================================================");
  console.log("Organizer:", organizer.address);
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
