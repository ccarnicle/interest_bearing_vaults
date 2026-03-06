// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPool} from "../interfaces/IPool.sol";
import {MockAToken} from "./MockAToken.sol";

/**
 * @title MockAavePool
 * @notice Minimal Aave-like pool mock for local tests.
 * @dev Tracks per-asset aToken contracts and mints/burns on supply/withdraw.
 */
contract MockAavePool is IPool {
    using SafeERC20 for IERC20;

    // asset => MockAToken address
    mapping(address => address) public aTokens;

    function addAsset(address asset, address aToken) external {
        aTokens[asset] = aToken;
    }

    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 /* referralCode */
    ) external override {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        MockAToken(aTokens[asset]).mint(onBehalfOf, amount);
    }

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external override returns (uint256) {
        MockAToken aToken = MockAToken(aTokens[asset]);
        uint256 available = aToken.balanceOf(msg.sender);
        uint256 toWithdraw = amount == type(uint256).max ? available : amount;
        require(toWithdraw <= available, "MockPool: insufficient balance");
        aToken.burn(msg.sender, toWithdraw);
        IERC20(asset).safeTransfer(to, toWithdraw);
        return toWithdraw;
    }

    /**
     * @dev Simulates yield accrual by minting additional aTokens to `user`.
     * Caller must ensure underlying liquidity exists in the pool.
     */
    function simulateYield(address asset, address user, uint256 yieldAmount) external {
        MockAToken(aTokens[asset]).mint(user, yieldAmount);
    }
}
