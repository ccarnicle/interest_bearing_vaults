import { ethers, network } from "hardhat";

function flowscanTxUrl(txHash: string): string {
  return `https://evm-testnet.flowscan.io/tx/${txHash}`;
}

async function main() {
  if (network.name !== "flowTestnet") {
    throw new Error("This script is intended for --network flowTestnet.");
  }

  const [deployer] = await ethers.getSigners();
  const organizerAddress = process.env.TESTNET_ORGANIZER_ADDRESS?.trim() || deployer.address;

  console.log("====================================================");
  console.log("Phase 2 Flow testnet deployment");
  console.log("====================================================");
  console.log("Deployer:", deployer.address);
  console.log("Organizer:", organizerAddress);
  console.log("Network:", network.name);
  console.log(
    "Balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "FLOW"
  );

  // 1) Deploy MockToken
  const MockToken = await ethers.getContractFactory("MockToken");
  const mockToken = await MockToken.deploy();
  await mockToken.waitForDeployment();
  const mockTokenAddress = await mockToken.getAddress();
  const mockTokenDeployTx = mockToken.deploymentTransaction();
  console.log("\nMockToken:", mockTokenAddress);
  if (mockTokenDeployTx) {
    console.log("  tx:", mockTokenDeployTx.hash);
    console.log("  url:", flowscanTxUrl(mockTokenDeployTx.hash));
  }

  // 2) Deploy MockAavePool first, then MockAToken with pool address
  // (The plan listed MockAToken before pool, but MockAToken requires pool in constructor.)
  const MockAavePool = await ethers.getContractFactory("MockAavePool");
  const mockAavePool = await MockAavePool.deploy();
  await mockAavePool.waitForDeployment();
  const mockAavePoolAddress = await mockAavePool.getAddress();
  const mockAavePoolDeployTx = mockAavePool.deploymentTransaction();
  console.log("\nMockAavePool:", mockAavePoolAddress);
  if (mockAavePoolDeployTx) {
    console.log("  tx:", mockAavePoolDeployTx.hash);
    console.log("  url:", flowscanTxUrl(mockAavePoolDeployTx.hash));
  }

  // 3) Deploy MockAToken
  const MockAToken = await ethers.getContractFactory("MockAToken");
  const mockAToken = await MockAToken.deploy(
    "Mock aStgUSDC",
    "aMockUSDC",
    mockAavePoolAddress
  );
  await mockAToken.waitForDeployment();
  const mockATokenAddress = await mockAToken.getAddress();
  const mockATokenDeployTx = mockAToken.deploymentTransaction();
  console.log("\nMockAToken:", mockATokenAddress);
  if (mockATokenDeployTx) {
    console.log("  tx:", mockATokenDeployTx.hash);
    console.log("  url:", flowscanTxUrl(mockATokenDeployTx.hash));
  }

  // 4) Register asset -> aToken in mock pool
  const addAssetTx = await mockAavePool.addAsset(mockTokenAddress, mockATokenAddress);
  await addAssetTx.wait();
  console.log("\naddAsset tx:", addAssetTx.hash);
  console.log("  url:", flowscanTxUrl(addAssetTx.hash));

  // 5) Deploy DFSEscrowManager
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

  // 6) Configure manager
  const txAllowedPool = await dfsEscrowManager.setAllowedPool(mockAavePoolAddress, true);
  await txAllowedPool.wait();

  const txAllowedToken = await dfsEscrowManager.setAllowedToken(mockTokenAddress, true);
  await txAllowedToken.wait();

  const txAToken = await dfsEscrowManager.setATokenForAsset(mockTokenAddress, mockATokenAddress);
  await txAToken.wait();

  const txCreator = await dfsEscrowManager.addAuthorizedCreator(organizerAddress);
  await txCreator.wait();

  console.log("\nConfiguration txs:");
  console.log("  setAllowedPool:", txAllowedPool.hash, flowscanTxUrl(txAllowedPool.hash));
  console.log("  setAllowedToken:", txAllowedToken.hash, flowscanTxUrl(txAllowedToken.hash));
  console.log("  setATokenForAsset:", txAToken.hash, flowscanTxUrl(txAToken.hash));
  console.log("  addAuthorizedCreator:", txCreator.hash, flowscanTxUrl(txCreator.hash));

  // Verify key config
  const allowedPool = await dfsEscrowManager.allowedPools(mockAavePoolAddress);
  const allowedToken = await dfsEscrowManager.allowedTokens(mockTokenAddress);
  const aTokenForAsset = await dfsEscrowManager.aTokenForAsset(mockTokenAddress);
  const isCreator = await dfsEscrowManager.isAuthorizedCreator(organizerAddress);

  console.log("\nConfig check:");
  console.log("  allowedPools[mockPool] =", allowedPool);
  console.log("  allowedTokens[mockToken] =", allowedToken);
  console.log("  aTokenForAsset[mockToken] =", aTokenForAsset);
  console.log("  isAuthorizedCreator[organizer] =", isCreator);

  console.log("\n====================================================");
  console.log("Copy these into .env for lifecycle test:");
  console.log("====================================================");
  console.log(`TESTNET_MOCK_TOKEN_ADDRESS=${mockTokenAddress}`);
  console.log(`TESTNET_MOCK_ATOKEN_ADDRESS=${mockATokenAddress}`);
  console.log(`TESTNET_MOCK_AAVE_POOL_ADDRESS=${mockAavePoolAddress}`);
  console.log(`TESTNET_DFS_ESCROW_MANAGER_ADDRESS=${dfsEscrowManagerAddress}`);
  console.log(`TESTNET_ORGANIZER_ADDRESS=${organizerAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
