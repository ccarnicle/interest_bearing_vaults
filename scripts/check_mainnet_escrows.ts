/**
 * Check escrow details on Flow mainnet to find which escrow has balance (for paid_usdc_4).
 */
import { ethers, network } from "hardhat";
import type { DFSEscrowManager } from "../typechain-types";

async function main() {
  if (network.name !== "flowMainnet") {
    throw new Error("Use --network flowMainnet");
  }
  const managerAddress =
    process.env.MAINNET_DFS_ESCROW_MANAGER_ADDRESS ||
    "0x97a582e24B6a68a4D654421D46c89B9923F1Fd40";
  const manager = (await ethers.getContractAt(
    "DFSEscrowManager",
    managerAddress
  )) as DFSEscrowManager;

  const nextId = await manager.nextEscrowId();
  console.log("nextEscrowId:", nextId.toString());
  console.log("");

  for (let id = 1; id < Number(nextId); id++) {
    try {
      const d = await manager.getEscrowDetails(BigInt(id));
      const block = await ethers.provider.getBlock("latest");
      const now = block ? BigInt(block.timestamp) : 0n;
      const pastLock = now > d.endTime;
      console.log(`Escrow ${id}:`);
      console.log("  organizer:", d.organizer);
      console.log("  leagueName:", d.leagueName);
      console.log("  escrowBalance:", d.escrowBalance.toString());
      console.log("  invested:", d.invested);
      console.log("  endTime:", d.endTime.toString(), pastLock ? "(past lock)" : "(not yet)");
      console.log("");
    } catch (e) {
      console.log(`Escrow ${id}: error`, e);
    }
  }
}

main().catch(console.error);
