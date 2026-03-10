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

  const addressToAdd = process.env.ADD_INVEST_CALLER_ADDRESS?.trim();
  if (!addressToAdd || !ethers.isAddress(addressToAdd)) {
    throw new Error(
      "Usage: ADD_INVEST_CALLER_ADDRESS=0x... npm run test:flowTestnet:addInvestCaller\n" +
        "Or: ADD_INVEST_CALLER_ADDRESS=0x... npx hardhat run scripts/add_invest_escrow_caller.ts --network flowTestnet"
    );
  }

  const [owner] = await ethers.getSigners();
  const managerAddress = mustGetEnv("TESTNET_DFS_ESCROW_MANAGER_ADDRESS");

  const manager = (await ethers.getContractAt(
    "DFSEscrowManager",
    managerAddress
  )) as DFSEscrowManager;

  const isAlreadyAllowed = await manager.investEscrowCallerAllowlist(addressToAdd);
  if (isAlreadyAllowed) {
    console.log("Address", addressToAdd, "is already on the invest escrow caller allowlist.");
    return;
  }

  console.log("====================================================");
  console.log("Add invest escrow caller");
  console.log("====================================================");
  console.log("Manager:", managerAddress);
  console.log("Owner:", owner.address);
  console.log("Address to add:", addressToAdd);

  const tx = await manager.addInvestEscrowCaller(addressToAdd);
  await tx.wait();

  const isAllowedAfter = await manager.investEscrowCallerAllowlist(addressToAdd);
  console.log("\nSuccess!");
  console.log("  Tx:", tx.hash, flowscanTxUrl(tx.hash));
  console.log("  investEscrowCallerAllowlist(" + addressToAdd + ") =", isAllowedAfter);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
