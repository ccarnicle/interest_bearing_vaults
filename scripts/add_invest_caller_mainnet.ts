/**
 * Add the frontend-agent COA address to the investEscrowCallerAllowlist on DFSEscrowManager.
 *
 * Prerequisites:
 *   - MAINNET_PRIVATE_KEY in .env (must be the contract owner)
 *   - MAINNET_DFS_ESCROW_MANAGER_ADDRESS in .env
 *
 * Usage:
 *   npx hardhat run scripts/add_invest_caller_mainnet.ts --network flowMainnet
 */

import { ethers, network } from "hardhat";
import type { DFSEscrowManager } from "../typechain-types";

const FRONTEND_AGENT_COA = "0x0000000000000000000000021ef092c4a124ea6e";

function mustGetEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main() {
  if (network.name !== "flowMainnet") {
    throw new Error("This script is intended for --network flowMainnet.");
  }

  const [signer] = await ethers.getSigners();
  const managerAddress = mustGetEnv("MAINNET_DFS_ESCROW_MANAGER_ADDRESS");

  const manager = (await ethers.getContractAt(
    "DFSEscrowManager",
    managerAddress
  )) as DFSEscrowManager;

  const isAlreadyAllowed = await manager.investEscrowCallerAllowlist(
    FRONTEND_AGENT_COA
  );

  if (isAlreadyAllowed) {
    console.log("COA", FRONTEND_AGENT_COA, "is already in the allowlist.");
    return;
  }

  console.log("Adding COA to investEscrowCallerAllowlist...");
  console.log("Caller:", signer.address);
  console.log("Manager:", managerAddress);
  console.log("COA:", FRONTEND_AGENT_COA);

  const tx = await manager.addInvestEscrowCaller(FRONTEND_AGENT_COA);
  await tx.wait();

  const isAllowed = await manager.investEscrowCallerAllowlist(FRONTEND_AGENT_COA);
  console.log("\nDone. investEscrowCallerAllowlist(COA):", isAllowed);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
