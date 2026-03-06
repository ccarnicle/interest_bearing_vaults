// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockAToken
 * @notice Minimal aToken-style ERC20 used for testing pool accounting.
 * @dev Only the configured pool can mint and burn.
 */
contract MockAToken is ERC20 {
    address public pool;

    constructor(
        string memory name,
        string memory symbol,
        address _pool
    ) ERC20(name, symbol) {
        pool = _pool;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == pool, "MockAToken: only pool");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == pool, "MockAToken: only pool");
        _burn(from, amount);
    }
}
