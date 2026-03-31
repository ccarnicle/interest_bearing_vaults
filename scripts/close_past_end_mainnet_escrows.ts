/**
 * Closes DFSEscrowManager "active" escrows that are past endTime.
 *
 * This uses the organizer-only combined settlement entrypoint:
 *   divestAndDistributeWinnings(escrowId, 0, [], [])
 *
 * For empty winners, the contract will treat all remaining balance as "overflow"
 * and remove the escrow from `activeEscrowIds` by setting payouts complete.
 *
 * SAFETY GUARD:
 * - Only auto-close when `escrowBalance == 0` to avoid accidentally redirecting funds
 *   without having winners/amounts.
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

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer available (missing MAINNET_PRIVATE_KEY?)");

  const manager = (await ethers.getContractAt(
    "DFSEscrowManager",
    managerAddress
  )) as DFSEscrowManager;

  const latestBlock = await ethers.provider.getBlock("latest");
  const now = latestBlock ? BigInt(latestBlock.timestamp) : 0n;

  const activeIds: bigint[] = await manager.getActiveEscrowIds();
  console.log("DFSEscrowManager:", managerAddress);
  console.log("Caller:", signer.address);
  console.log("Now:", now.toString());
  console.log("Active escrow count:", activeIds.length.toString());

  const toClose: bigint[] = [];
  for (const id of activeIds) {
    const d = await manager.getEscrowDetails(id);
    const pastLock = now > d.endTime;
    if (!pastLock) continue;

    if (d.payoutsComplete) {
      console.log(`- Escrow ${id.toString()} already has payoutsComplete=true (skip).`);
      continue;
    }

    if (d.escrowBalance !== 0n) {
      console.log(
        `- Escrow ${id.toString()} past endTime but escrowBalance != 0 (${d.escrowBalance.toString()}); skipping auto-close.`
      );
      continue;
    }

    toClose.push(id);
  }

  console.log("");
  console.log("Auto-closing eligible escrows (empty winners):", toClose.map((x) => x.toString()));

  for (const escrowId of toClose) {
    const details = await manager.getEscrowDetails(escrowId);
    if (details.organizer.toLowerCase() !== signer.address.toLowerCase()) {
      console.log(
        `- Escrow ${escrowId.toString()} organizer is ${details.organizer} (not caller); skipping tx.`
      );
      continue;
    }

    console.log(`Closing escrow ${escrowId.toString()}...`);
    const tx = await manager.divestAndDistributeWinnings(
      escrowId,
      0n,
      [] as string[],
      [] as bigint[]
    );
    console.log("  tx:", tx.hash);
    await tx.wait();
  }

  const remainingActive: bigint[] = await manager.getActiveEscrowIds();
  console.log("");
  console.log("Remaining active escrow count:", remainingActive.length.toString());
  console.log("Remaining active escrow IDs:", remainingActive.map((x) => x.toString()));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

