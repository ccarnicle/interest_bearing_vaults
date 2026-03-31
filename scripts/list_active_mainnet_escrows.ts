/**
 * Lists DFSEscrowManager active/open escrows on Flow mainnet.
 *
 * "Active" here means: present in `getActiveEscrowIds()` (not yet settled via payouts).
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

  const activeIds = await manager.getActiveEscrowIds();
  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock ? BigInt(latestBlock.timestamp) : 0n;

  console.log("DFSEscrowManager:", managerAddress);
  console.log("Active escrow count:", activeIds.length.toString());
  console.log("Now:", now.toString());

  for (const id of activeIds) {
    const d = await manager.getEscrowDetails(id);
    const pastLock = now > d.endTime;

    console.log("");
    console.log(`Escrow ${id.toString()}:`);
    console.log(`  organizer: ${d.organizer}`);
    console.log(`  leagueName: ${d.leagueName}`);
    console.log(`  pool: ${d.pool}`);
    console.log(`  token: ${d.token}`);
    console.log(`  dues: ${d.dues.toString()}`);
    console.log(
      `  endTime: ${d.endTime.toString()} ${pastLock ? "(past lock)" : "(not yet)"}`
    );
    console.log(`  escrowBalance: ${d.escrowBalance.toString()}`);
    console.log(
      `  invested: ${d.invested} withdrawn: ${d.withdrawn} principalInvested: ${d.principalInvested.toString()}`
    );
    console.log(`  payoutsComplete: ${d.payoutsComplete}`);

    // Only used to decide whether it is safe to "close" with empty winners.
    try {
      const participants = await manager.getParticipants(id);
      console.log(`  participants: ${participants.length.toString()}`);
    } catch (e) {
      console.log("  participants: <error>");
    }
  }
}

main().catch(console.error);

