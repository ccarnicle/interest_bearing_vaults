import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 1337, // This forces the Hardhat Network to use a specific chainId
    },
    flowTestnet: {
      url: 'https://testnet.evm.nodes.onflow.org',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    flowMainnet: {
      url: 'https://mainnet.evm.nodes.onflow.org',
      chainId: 747,
      accounts: process.env.MAINNET_PRIVATE_KEY ? [process.env.MAINNET_PRIVATE_KEY] : [],
    },
    arbitrumSepolia: {
      url: 'https://sepolia-rollup.arbitrum.io/rpc',
      chainId: 421614,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    baseSepolia: {
      url: 'https://sepolia.base.org',
      chainId: 84532,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    arbitrumOne: {
      url: 'https://arb1.arbitrum.io/rpc',
      chainId: 42161,
      accounts: process.env.MAINNET_PRIVATE_KEY ? [process.env.MAINNET_PRIVATE_KEY] : [],
    },
    base: {
      url: 'https://mainnet.base.org',
      chainId: 8453,
      accounts: process.env.MAINNET_PRIVATE_KEY ? [process.env.MAINNET_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    // Network-keyed apiKey required so hardhat-verify uses customChains (BlockScout) for Flow
    // instead of Etherscan v2 API (which errors: "Missing or unsupported chainid").
    // FlowScan/BlockScout accepts any non-empty string for Flow networks.
    apiKey: {
      flowTestnet: 'flowscan',
      flowMainnet: 'flowscan',
      arbitrumSepolia: process.env.ETHERSCAN_API_KEY || '',
      baseSepolia: process.env.ETHERSCAN_API_KEY || '',
      arbitrumOne: process.env.ETHERSCAN_API_KEY || '',
      base: process.env.ETHERSCAN_API_KEY || '',
    },
    customChains: [
      {
        network: 'flowTestnet',
        chainId: 545,
        urls: {
          apiURL: 'https://evm-testnet.flowscan.io/api',
          browserURL: 'https://evm-testnet.flowscan.io/',
        },
      },
      {
        network: 'flowMainnet',
        chainId: 747,
        urls: {
          apiURL: 'https://evm.flowscan.io/api',
          browserURL: 'https://evm.flowscan.io/',
        },
      },
      {
        network: 'arbitrumSepolia',
        chainId: 421614,
        urls: {
          apiURL: 'https://api-sepolia.arbiscan.io/api',
          browserURL: 'https://sepolia.arbiscan.io/',
        },
      },
      {
        network: 'baseSepolia',
        chainId: 84532,
        urls: {
          apiURL: 'https://api-sepolia.basescan.org/api',
          browserURL: 'https://sepolia.basescan.org/',
        },
      },
    ],
  },
  sourcify: {
    enabled: false,
  },
};

export default config;
